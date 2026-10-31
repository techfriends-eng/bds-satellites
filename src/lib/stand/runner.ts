import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * Прогон кода статьи на стенде (progon, локально): run.sh поднимает стенд и запускает основной
 * пример, затем по одному запускаются файлы с местом для вывода, и всегда — docker compose down -v.
 * Проект compose — sat-<site>-<id> (карточка стенда progon).
 */
export type StepResult = { rc: number; out: string; seconds: number };
export type RunResults = Record<string, StepResult>;
export type Exec = (
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => StepResult;

const TIMEOUT_MS: Record<string, number> = { "run.sh": 25 * 60_000 };
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// ESC-последовательности цвета из вывода docker и pip; ESC собирается кодом, а не литералом в регулярке.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const SAFE_NAME = /^(?!.*\.\.)[\w.-]+(\/[\w.-]+)*$/;

/** Выход и ошибки одним потоком в порядке появления; таймаут — код 124, как у coreutils timeout. */
export const shellExec: Exec = (cmd, cwd, env, timeoutMs) => {
  const started = Date.now();
  const r = spawnSync("bash", ["-c", `exec 2>&1; ${cmd}`], {
    cwd,
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const out =
    (r.stdout ?? "").replace(ANSI, "") + (timedOut ? `\n[таймаут ${timeoutMs / 1000} с]` : "");
  return {
    rc: timedOut ? 124 : (r.status ?? 1),
    out,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
};

export function commandFor(name: string, work: string): string {
  if (name.endsWith(".sh")) return `bash ${name}`;
  if (name.endsWith(".py")) {
    const py = existsSync(join(work, ".venv", "bin", "python")) ? ".venv/bin/python" : "python3";
    return `${py} ${name}`;
  }
  throw new Error(`не знаю, как запустить ${name}`);
}

export function badNames(files: Map<string, string>): string[] {
  return [...files.keys()].filter((n) => !SAFE_NAME.test(n) || normalize(n).startsWith(".."));
}

export function runStand(
  work: string,
  project: string,
  files: Map<string, string>,
  outputs: string[],
  exec: Exec = shellExec,
): RunResults {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const [name, body] of files) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), body, { mode: name.endsWith(".sh") ? 0o755 : 0o644 });
  }
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project, KEEP: "1", PYTHONUNBUFFERED: "1" };
  const results: RunResults = {};
  try {
    for (const name of ["run.sh", ...outputs.filter((n) => n !== "run.sh")]) {
      results[name] = exec(
        commandFor(name, work),
        work,
        env,
        TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS,
      );
      if (name === "run.sh" && results[name].rc !== 0) break; // без стенда задания не имеют смысла
    }
  } finally {
    if (files.has("compose.yaml")) {
      results._down = exec("docker compose down -v --remove-orphans", work, env, 120_000);
    }
  }
  return results;
}

export function failed(results: RunResults): RunResults {
  return Object.fromEntries(Object.entries(results).filter(([, r]) => r.rc !== 0));
}
