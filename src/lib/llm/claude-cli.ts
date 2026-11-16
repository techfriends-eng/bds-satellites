import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Бэкенд `claude-cli:<alias>` (ADR 0002, п. 2): вызов модели по подписке Claude через `claude -p`.
 * Подписка общая с работой автора, поэтому перед вызовом смотрим загрузку окон из `rate_limit_event`
 * (его выдаёт `--output-format stream-json`): окно 5 часов занято меньше порога и недельное окно не
 * опережает равномерный темп до сброса. Последние 24 часа перед недельным сбросом порог 5 часов выше:
 * остаток недели всё равно сгорит. Нет события или порог превышен — этап уходит на запасную модель.
 *
 * Вызов изолирован: пустой временный каталог, `--setting-sources ""` (без CLAUDE.md, хуков и плагинов
 * машины), `--tools ""`, без сохранения сессии. Системный промпт — файлом: он бывает длиннее лимита
 * аргумента. Токен подписки — `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), RUNBOOK §12.
 */

export type Window = { utilization: number; resetsAt: number; status?: string };
export type Limits = {
  status: string;
  fiveHour?: Window;
  sevenDay?: Window;
  /** Когда событие получено, unix-секунды. */
  at: number;
};

export type CliRun = (
  args: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type CliResult = {
  text: string;
  model: string;
  truncated: boolean;
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number; costUsd: 0 };
  limits?: Limits;
};

export type CliOptions = {
  /** Порог окна 5 часов, доля: по умолчанию 0.3 — остальное автору. */
  fiveHourMax: number;
  /** Порог окна 5 часов в последние 24 часа перед недельным сбросом. */
  lastDayFiveHourMax: number;
  /** Сведения о лимитах старше этого — сначала дешёвая проба. */
  maxAgeMin: number;
  /** Модель пробы: самая дешёвая по лимитам. */
  probeModel: string;
};

export const CLI_DEFAULTS: CliOptions = {
  fiveHourMax: 0.3,
  lastDayFiveHourMax: 0.6,
  maxAgeMin: 15,
  probeModel: "haiku",
};

const WEEK = 7 * 24 * 3600;

export const spawnRun: CliRun = (args, input, { cwd, timeoutMs, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.SAT_CLAUDE_BIN ?? "claude", args, { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });

function window(w: unknown): Window | undefined {
  const x = w as { utilization?: unknown; resetsAt?: unknown; status?: unknown } | undefined;
  if (typeof x?.utilization !== "number" || typeof x.resetsAt !== "number") return undefined;
  return { utilization: x.utilization, resetsAt: x.resetsAt, status: x.status as string };
}

/** Разбор вывода `claude -p --output-format stream-json --verbose`: ответ и последнее событие лимитов. */
export function parseStream(stdout: string, alias: string, now: number): CliResult {
  let limits: Limits | undefined;
  let result: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "rate_limit_event") {
      const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
      const win = (info.unifiedWindows ?? {}) as Record<string, unknown>;
      limits = {
        status: String(info.status ?? ""),
        fiveHour: window(win.five_hour),
        sevenDay: window(win.seven_day),
        at: now,
      };
    } else if (ev.type === "result") result = ev;
  }
  if (!result) throw new Error("claude-cli: в выводе нет result");
  if (result.is_error || result.subtype !== "success") {
    throw new Error(`claude-cli: ${String(result.result ?? result.subtype).slice(0, 300)}`);
  }
  const u = (result.usage ?? {}) as Record<string, number>;
  const model = Object.keys((result.modelUsage ?? {}) as object)[0] ?? alias;
  return {
    text: String(result.result ?? ""),
    model,
    truncated: result.stop_reason === "max_tokens",
    usage: {
      promptTokens:
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0),
      completionTokens: u.output_tokens ?? 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    limits,
  };
}

/** Можно ли тратить подписку сейчас. `why` — причина отказа по-русски, для журнала. */
export function subscriptionAllows(
  l: Limits | undefined,
  now: number,
  o: CliOptions,
): { ok: boolean; why: string } {
  if (!l) return { ok: false, why: "нет сведений о лимитах подписки" };
  if (l.status !== "allowed") return { ok: false, why: `подписка: статус ${l.status}` };
  const fh = l.fiveHour;
  const sd = l.sevenDay;
  if (!fh || !sd) return { ok: false, why: "в событии лимитов нет окон five_hour и seven_day" };
  const weekLeft = sd.resetsAt - now;
  const lastDay = weekLeft <= 24 * 3600;
  const fhMax = lastDay ? o.lastDayFiveHourMax : o.fiveHourMax;
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  if (fh.utilization >= fhMax) {
    return { ok: false, why: `окно 5 ч занято на ${pct(fh.utilization)}, порог ${pct(fhMax)}` };
  }
  const pace = Math.min(1, Math.max(0, 1 - weekLeft / WEEK));
  if (!lastDay && sd.utilization > pace) {
    return {
      ok: false,
      why: `неделя занята на ${pct(sd.utilization)}, равномерный темп ${pct(pace)}`,
    };
  }
  return { ok: true, why: "" };
}

export type ClaudeCli = {
  /** Решение по подписке; при устаревших сведениях сначала проба. */
  allowed(): Promise<{ ok: boolean; why: string }>;
  ask(alias: string, system: string, user: string, effort?: string): Promise<CliResult>;
};

/**
 * `limitsFile` — последние сведения о лимитах между прогонами (state/claude-limits.json):
 * у прогонов разные процессы, а проба тоже тратит подписку.
 */
export function createClaudeCli(
  opts: CliOptions,
  limitsFile: string | null,
  env: NodeJS.ProcessEnv,
  run: CliRun = spawnRun,
  clock: () => number = () => Math.floor(Date.now() / 1000),
): ClaudeCli {
  let limits: Limits | undefined;
  if (limitsFile) {
    try {
      limits = JSON.parse(readFileSync(limitsFile, "utf8")) as Limits;
    } catch {
      /* файла нет или испорчен — будет проба */
    }
  }
  const remember = (l: Limits | undefined) => {
    if (!l) return;
    limits = l;
    if (limitsFile) {
      try {
        writeFileSync(limitsFile, JSON.stringify(l));
      } catch {
        /* не записали — в следующем прогоне будет проба */
      }
    }
  };

  async function call(
    alias: string,
    system: string,
    user: string,
    effort: string | undefined,
    timeoutMs: number,
  ): Promise<CliResult> {
    const dir = mkdtempSync(join(tmpdir(), "sat-claude-"));
    try {
      const sys = join(dir, "system.txt");
      writeFileSync(sys, system);
      const args = [
        "-p",
        "--model",
        alias,
        "--system-prompt-file",
        sys,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(effort ? ["--effort", effort] : []),
      ];
      const r = await run(args, user, { cwd: dir, timeoutMs, env });
      let res: CliResult;
      try {
        res = parseStream(r.stdout, alias, clock());
      } catch (err) {
        const tail = r.stderr.trim().split("\n").slice(-3).join(" | ");
        throw new Error(
          `${(err as Error).message}; код ${r.code}${tail ? `; stderr: ${tail.slice(0, 300)}` : ""}`,
        );
      }
      remember(res.limits);
      return res;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    async allowed() {
      if (!limits || clock() - limits.at > opts.maxAgeMin * 60) {
        try {
          await call(opts.probeModel, "Ответь одним словом: ok", "ok", undefined, 120_000);
        } catch (err) {
          return { ok: false, why: `проба подписки не удалась: ${(err as Error).message}` };
        }
      }
      return subscriptionAllows(limits, clock(), opts);
    },
    ask: (alias, system, user, effort) => call(alias, system, user, effort, 600_000),
  };
}
