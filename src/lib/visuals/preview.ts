import { OPENROUTER } from "../llm/client.ts";

/**
 * Превью-картинка по промпту B5.2 через OpenRouter (решение автора: Gemini Image). Основная модель и
 * запасная — маршрут fallback OpenRouter, как в wiki_visualizer (scripts/lib/openrouter_image.sh).
 * Ответ — data URI в choices[0].message.images[0].image_url.url.
 */
export type PreviewResult = { bytes: Buffer; ext: string; model: string; costUsd: number };

export async function generatePreview(opts: {
  apiKey: string;
  models: string[];
  prompt: string;
  size?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<PreviewResult> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${OPENROUTER}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      models: opts.models,
      route: "fallback",
      modalities: ["image", "text"],
      usage: { include: true },
      messages: [
        {
          role: "user",
          content: `${opts.prompt}\n\nOutput resolution: ${opts.size ?? "1200x800"}.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`превью: HTTP ${res.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as {
    model?: string;
    usage?: { cost?: number };
    choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
  };
  const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  const mime = /^data:image\/([a-zA-Z]+);base64,/.exec(url);
  const b64 = url.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
  if (!b64) throw new Error(`превью: в ответе нет картинки (${text.slice(0, 200)})`);
  return {
    bytes: Buffer.from(b64, "base64"),
    // Расширение из MIME: по «.raw» ImageMagick берёт камерный RAW и зовёт ufraw-batch, которого нет.
    ext: (mime?.[1] ?? "png").toLowerCase(),
    model: body.model ?? "",
    costUsd: body.usage?.cost ?? 0,
  };
}
