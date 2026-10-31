import type { ChatClient } from "@techfriends-eng/toolkit/llm";
import type { SiteConfig } from "../config/site.ts";
import { nowIso, type Db } from "../store/db.ts";

/**
 * Вызов модели для этапов конвейера поверх toolkit/llm completeDetailed: журнал расхода в llm_calls,
 * потолок расхода на прогон, рассуждение этапа (у Claude 5 — только effort, handbook
 * gotchas/llm.md#claude5-reasoning), обрезанный ответ — ошибка с текстом, за который уже заплачено.
 */
export const OPENROUTER = "https://openrouter.ai/api/v1";

export type Stage = keyof SiteConfig["llm"]["models"];

export class BudgetExceeded extends Error {}
export class Truncated extends Error {
  readonly text: string;
  constructor(stage: string, maxTokens: number, text: string) {
    super(`${stage}: ответ обрезан по maxTokens=${maxTokens}`);
    this.text = text;
  }
}

export type Llm = {
  ask(
    stage: Stage,
    system: string,
    user: string,
    maxTokens: number,
    candidateId?: number,
  ): Promise<string>;
  spent(): number;
};

export function createLlm(db: Db, cfg: SiteConfig, chat: ChatClient): Llm {
  let spent = 0;
  const log = db.prepare(
    `INSERT INTO llm_calls (at, stage, model, candidate_id, prompt_tokens, completion_tokens, reasoning_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    spent: () => spent,
    async ask(stage, system, user, maxTokens, candidateId) {
      if (spent >= cfg.llm.maxCostPerRunUsd) {
        throw new BudgetExceeded(
          `потолок прогона $${cfg.llm.maxCostPerRunUsd} исчерпан ($${spent.toFixed(3)})`,
        );
      }
      const model = cfg.llm.models[stage];
      if (!model) throw new Error(`llm.models.${stage} не задан в конфиге сайта`);
      const res = await chat.completeDetailed({
        model,
        system,
        user,
        maxTokens,
        timeoutMs: 600_000,
        headers: { "HTTP-Referer": `https://${cfg.domain}`, "X-Title": "bds-satellites" },
        body: {
          usage: { include: true },
          ...(cfg.llm.reasoning[stage] ? { reasoning: cfg.llm.reasoning[stage] } : {}),
        },
      });
      if (!res) throw new Error(`${stage}: модель не ответила после повторов`);
      spent += res.usage.costUsd;
      const u = res.usage;
      log.run(
        nowIso(),
        stage,
        model,
        candidateId ?? null,
        u.promptTokens,
        u.completionTokens,
        u.reasoningTokens,
        u.costUsd,
      );
      if (res.finishReason === "length") throw new Truncated(stage, maxTokens, res.text);
      return res.text;
    },
  };
}

/** Первое цельное JSON-значение с позиции start: баланс скобок с учётом строк и экранирования. */
function firstValue(t: string, start: number): string {
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return t.slice(start, i + 1);
  }
  throw new SyntaxError("в ответе незакрытый JSON");
}

/**
 * JSON из ответа модели. Внутри JSON бывает код с ``` — поэтому сначала весь ответ, потом обёртка
 * ```json целиком, потом первое цельное значение от первой { или [ (handbook gotchas/llm.md#json-with-fences).
 * Последний случай закрывает и «Extra data»: модель дописала после JSON второй объект или пояснение.
 */
export function parseJson<T = unknown>(text: string): T {
  const t = text.trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    /* дальше */
  }
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*)```\s*$/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* дальше */
    }
  }
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) throw new SyntaxError("в ответе нет JSON");
  return JSON.parse(firstValue(t, Math.min(...starts))) as T;
}
