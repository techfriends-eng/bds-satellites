import { OPENROUTER } from "../llm/client.ts";

/**
 * Превью-картинка по промпту B5.2 через OpenRouter (решение автора: Gemini Image). Основная модель и
 * запасная — маршрут fallback OpenRouter, как в wiki_visualizer (scripts/lib/openrouter_image.sh).
 * Ответ — data URI в choices[0].message.images[0].image_url.url. Модель иногда отвечает без картинки:
 * до трёх попыток, каждая следующая начинает с другой модели.
 */
export type PreviewResult = { bytes: Buffer; ext: string; model: string; costUsd: number };

/** За ответ без картинки провайдер берёт деньги: неудача несёт расход, он идёт в журнал и в потолок. */
export class PreviewFailed extends Error {
  readonly costUsd: number;
  constructor(message: string, costUsd: number) {
    super(message);
    this.costUsd = costUsd;
  }
}

class Attempt extends Error {
  readonly costUsd: number;
  readonly retry: boolean;
  constructor(message: string, retry: boolean, costUsd = 0) {
    super(message);
    this.retry = retry;
    this.costUsd = costUsd;
  }
}

/** Повтор имеет смысл при сбое провайдера. Пустой баланс (402) и плохой запрос повтор не лечит. */
const RETRY_STATUS = new Set([408, 425, 429]);

async function attempt(
  doFetch: typeof fetch,
  apiKey: string,
  models: string[],
  prompt: string,
  size: string,
  timeoutMs: number,
): Promise<PreviewResult> {
  let res: Response;
  let text: string;
  try {
    res = await doFetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        models,
        route: "fallback",
        modalities: ["image", "text"],
        usage: { include: true },
        messages: [{ role: "user", content: `${prompt}\n\nOutput resolution: ${size}.` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw new Attempt(`превью: ${(err as Error).message}`, true); // сеть, таймаут
  }
  // OpenRouter держит соединение пробелами перед JSON: без trim в сообщении об ошибке только они.
  const brief = text.trim().slice(0, 300);
  if (!res.ok) {
    const retry = res.status >= 500 || RETRY_STATUS.has(res.status);
    throw new Attempt(`превью: HTTP ${res.status} ${brief}`, retry);
  }
  let body: {
    model?: string;
    usage?: { cost?: number };
    error?: { message?: string };
    choices?: {
      finish_reason?: string;
      message?: { content?: string; images?: { image_url?: { url?: string } }[] };
    }[];
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Attempt(`превью: ответ не JSON (${brief})`, true);
  }
  const costUsd = body.usage?.cost ?? 0;
  const choice = body.choices?.[0];
  const url = choice?.message?.images?.[0]?.image_url?.url ?? "";
  const mime = /^data:image\/([a-zA-Z]+);base64,/.exec(url);
  const b64 = url.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
  if (!b64) {
    const why = [body.model, choice?.finish_reason, body.error?.message, choice?.message?.content]
      .filter(Boolean)
      .join("; ")
      .slice(0, 200);
    throw new Attempt(`превью: в ответе нет картинки (${why || brief})`, true, costUsd);
  }
  return {
    bytes: Buffer.from(b64, "base64"),
    // Расширение из MIME: по «.raw» ImageMagick берёт камерный RAW и зовёт ufraw-batch, которого нет.
    ext: (mime?.[1] ?? "png").toLowerCase(),
    model: body.model ?? "",
    costUsd,
  };
}

export async function generatePreview(opts: {
  apiKey: string;
  models: string[];
  prompt: string;
  size?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PreviewResult> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let costUsd = 0;
  for (let i = 0; ; i++) {
    // Fallback OpenRouter срабатывает на ошибку, а не на пустой ответ: повтор начинает со следующей модели.
    const shift = i % opts.models.length;
    const models = [...opts.models.slice(shift), ...opts.models.slice(0, shift)];
    try {
      const r = await attempt(
        opts.fetch ?? fetch,
        opts.apiKey,
        models,
        opts.prompt,
        opts.size ?? "1200x800",
        opts.timeoutMs ?? 180_000,
      );
      return { ...r, costUsd: costUsd + r.costUsd };
    } catch (err) {
      if (!(err instanceof Attempt)) throw err;
      costUsd += err.costUsd;
      if (!err.retry || i + 1 >= attempts) throw new PreviewFailed(err.message, costUsd);
      await sleep(5_000 * (i + 1));
    }
  }
}
