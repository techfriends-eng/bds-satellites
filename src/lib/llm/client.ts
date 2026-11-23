import type { ChatClient, ChatContentPart, Ledger } from "@techfriends-eng/toolkit/llm";
import type { SiteConfig } from "../config/site.ts";
import { nowIso, type Db } from "../store/db.ts";
import type { ClaudeCli } from "./claude-cli.ts";

/**
 * Вызов модели для этапов конвейера поверх toolkit/llm completeDetailed: журнал расхода в llm_calls,
 * потолок расхода на прогон, рассуждение этапа (у Claude 5 — только effort, handbook
 * gotchas/llm.md#claude5-reasoning), обрезанный ответ — ошибка с текстом, за который уже заплачено.
 * Каждый вызов и расход дублируется в общий журнал `llm.calls` на supan8n (bds-content ADR 0001, шаг 5c),
 * если передан `ledger`. Запись туда не ждёт ответа базы: `flush()` перед выходом.
 *
 * У этапа — список моделей с откатом (ADR 0002, п. 2): `openrouter:<id>` (или просто id) и
 * `claude-cli:<alias>` (подписка, см. claude-cli.ts). Модель не ответила, упала или подписка занята —
 * берётся следующая. Обрезанный ответ и потолок прогона не откатываются: это не сбой модели.
 */
export const OPENROUTER = "https://openrouter.ai/api/v1";

export type Stage = keyof SiteConfig["llm"]["models"];

export type ModelSpec =
  | { provider: "openrouter"; id: string }
  | { provider: "claude-cli"; id: string };

/** `openrouter:<id>`, `claude-cli:<alias>` или просто id OpenRouter. Остальное — ошибка конфига. */
export function parseModel(spec: string): ModelSpec {
  const m = spec.match(/^([a-z-]+):(.+)$/);
  if (!m) return { provider: "openrouter", id: spec };
  if (m[1] === "openrouter" || m[1] === "claude-cli") return { provider: m[1], id: m[2] };
  throw new Error(`модель ${spec}: бэкенд ${m[1]} не поддержан (есть openrouter:, claude-cli:)`);
}

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
    /** Текст или части сообщения (видео — только OpenRouter, у `claude-cli:` отказ и откат). */
    user: string | ChatContentPart[],
    maxTokens: number,
    candidateId?: number,
  ): Promise<string>;
  spent(): number;
  /** Потолок прогона или недели исчерпан: платные вызовы дальше не делаются. */
  exhausted(): boolean;
  /** Расход вне ask (картинки): в журнал llm_calls и в потолок прогона. ok=false — оплачено, но не годно. */
  charge(stage: Stage, model: string, costUsd: number, candidateId?: number, ok?: boolean): void;
  /** Дождаться записей в общий журнал (перед выходом процесса). */
  flush(): Promise<void>;
};

/** Команды прогонов по таймеру (ADR 0002 §3): только у них потолок недели. */
export const TIMER_COMMANDS = ["run", "tick"] as const;

/**
 * Расход недели для потолка: только вызовы прогонов по таймеру с начала недели `since`.
 * Ручные команды автора (rework, regate и т. п.) потолок обходят и в расход тактов не входят.
 */
export function weekSpent(db: Db, since: string): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls
          WHERE at >= ? AND command IN (${TIMER_COMMANDS.map(() => "?").join(", ")})`,
      )
      .get(since, ...TIMER_COMMANDS) as { s: number }
  ).s;
}

export function createLlm(
  db: Db,
  cfg: SiteConfig,
  chat: ChatClient,
  ledger?: Ledger,
  cli?: ClaudeCli,
  /** Расход недели сайта до этого процесса (такты, ADR 0002 §3); null — без потолка недели. */
  weekBase: number | null = null,
  /** Команда процесса (`sat <command>`), пишется в llm_calls: потолок недели считает только такты. */
  command: string | null = null,
): Llm {
  let spent = 0;
  const over = (): string | null => {
    const { maxCostPerRunUsd: run, maxCostPerWeekUsd: week } = cfg.llm;
    if (spent >= run) return `потолок прогона $${run} исчерпан ($${spent.toFixed(3)})`;
    if (weekBase !== null && weekBase + spent >= week)
      return `потолок недели $${week} исчерпан ($${(weekBase + spent).toFixed(3)})`;
    return null;
  };
  const pending: Promise<void>[] = [];
  const record = (entry: Parameters<Ledger["record"]>[0]) => {
    if (ledger) pending.push(ledger.record({ provider: "openrouter", site: cfg.siteId, ...entry }));
  };
  const log = db.prepare(
    `INSERT INTO llm_calls (at, stage, model, candidate_id, prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, variant, command)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ab = cfg.llm.ab;
  /** Вариант темы: записан — тот же, нет — тот, у которого меньше тем (при равенстве — первый). */
  const variantOf = (id: number): string => {
    if (!ab) throw new Error("A/B не настроен");
    const row = db.prepare("SELECT variant FROM candidates WHERE id = ?").get(id) as
      | { variant: string | null }
      | undefined;
    if (row?.variant && ab.variants[row.variant]) return row.variant;
    const used = new Map(
      (
        db
          .prepare(
            "SELECT variant, COUNT(*) AS n FROM candidates WHERE variant IS NOT NULL GROUP BY variant",
          )
          .all() as { variant: string; n: number }[]
      ).map((r) => [r.variant, r.n]),
    );
    const names = Object.keys(ab.variants);
    const pick = names.reduce((a, b) => ((used.get(b) ?? 0) < (used.get(a) ?? 0) ? b : a));
    db.prepare("UPDATE candidates SET variant = ? WHERE id = ?").run(pick, id);
    return pick;
  };
  return {
    spent: () => spent,
    exhausted: () => over() !== null,
    async flush() {
      await Promise.all(pending.splice(0));
    },
    charge(stage, model, costUsd, candidateId, ok = true) {
      spent += costUsd;
      log.run(nowIso(), stage, model, candidateId ?? null, 0, 0, 0, costUsd, null, command);
      record({ stage, model, ref: candidateId, usage: { costUsd }, ok });
    },
    async ask(stage, system, user, maxTokens, candidateId) {
      const variant =
        ab && ab.stages.includes(stage) && candidateId !== undefined
          ? variantOf(candidateId)
          : null;
      const models = variant ? ab!.variants[variant] : cfg.llm.models[stage];
      if (!models?.length) throw new Error(`llm.models.${stage} не задан в конфиге сайта`);
      let lastErr: Error | undefined;
      for (const [i, spec] of models.entries()) {
        const ceiling = over();
        if (ceiling) throw new BudgetExceeded(ceiling);
        const next = models[i + 1] ? `, дальше ${models[i + 1]}` : "";
        try {
          const m = parseModel(spec);
          if (m.provider === "claude-cli")
            return await viaCli(m.id, stage, system, user, candidateId, variant);
          return await viaOpenRouter(m.id, stage, system, user, maxTokens, candidateId, variant);
        } catch (err) {
          if (err instanceof Truncated || err instanceof BudgetExceeded) throw err;
          lastErr = err as Error;
          console.error(`${stage}: ${spec} — ${lastErr.message}${next}`);
        }
      }
      throw lastErr ?? new Error(`${stage}: ни одна модель не ответила`);
    },
  };

  async function viaOpenRouter(
    model: string,
    stage: Stage,
    system: string,
    user: string | ChatContentPart[],
    maxTokens: number,
    candidateId: number | undefined,
    variant: string | null,
  ): Promise<string> {
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
      variant,
      command,
    );
    record({
      stage,
      model: res.model,
      ref: candidateId,
      usage: u,
      ok: res.finishReason !== "length",
    });
    if (res.finishReason === "length") throw new Truncated(stage, maxTokens, res.text);
    return res.text;
  }

  /** Подписка: денег прогона не тратит (cost 0), в журнал идёт с provider claude-cli. */
  async function viaCli(
    alias: string,
    stage: Stage,
    system: string,
    user: string | ChatContentPart[],
    candidateId: number | undefined,
    variant: string | null,
  ): Promise<string> {
    if (!cli) throw new Error("бэкенд claude-cli не подключён");
    if (typeof user !== "string") throw new Error("claude-cli принимает только текст");
    const gate = await cli.allowed();
    if (!gate.ok) throw new Error(gate.why);
    const effort = cfg.llm.reasoning[stage]?.effort;
    const res = await cli.ask(alias, system, user, typeof effort === "string" ? effort : undefined);
    const u = res.usage;
    log.run(
      nowIso(),
      stage,
      `claude-cli:${res.model}`,
      candidateId ?? null,
      u.promptTokens,
      u.completionTokens,
      0,
      0,
      variant,
      command,
    );
    record({
      stage,
      model: res.model,
      provider: "claude-cli",
      ref: candidateId,
      usage: u,
      ok: !res.truncated,
    });
    if (res.truncated) throw new Truncated(stage, 0, res.text);
    return res.text;
  }
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
