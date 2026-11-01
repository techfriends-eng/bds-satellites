import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArticle, setFile, setOutputs } from "../article/html.ts";
import type { SiteConfig } from "../config/site.ts";
import { draftPaths } from "../generate/draft.ts";
import { parseJson, type Llm } from "../llm/client.ts";
import { render } from "../prompts/render.ts";
import type { Db } from "../store/db.ts";
import { badNames, failed, runStand, shellExec, type Exec, type RunResults } from "./runner.ts";

/** Шаг прогона: код статьи на стенде, до stand.maxFixes починок через LLM, настоящий вывод в статью. */

const TAIL = 4000;

export type StandDeps = { db: Db; cfg: SiteConfig; llm: Llm; promptDirs: string[]; exec?: Exec };
type LogEntry = {
  attempt: number;
  rc?: Record<string, number>;
  warning?: string;
  error?: string;
  cause?: string;
};

function brief(results: RunResults): string {
  return Object.entries(results)
    .map(([k, v]) => `### ${k}: rc=${v.rc}, ${v.seconds} с\n${v.out.slice(-TAIL)}`)
    .join("\n\n");
}

export async function checkDraft(
  deps: StandDeps,
  draft: { candidate_id: number; dir: string },
  slug: string,
): Promise<boolean> {
  const { db, cfg, llm, promptDirs } = deps;
  const paths = draftPaths(draft.dir, slug);
  let html = readFileSync(paths.html, "utf8");
  const project = `sat-${cfg.siteId}-${draft.candidate_id}`;
  const log: LogEntry[] = [];
  let results: RunResults = {};
  let outputs: string[] = [];
  for (let attempt = 0; attempt <= cfg.stand.maxFixes; attempt++) {
    const parsed = parseArticle(html);
    outputs = parsed.outputs;
    const bad = badNames(parsed.files);
    if (bad.length || !parsed.files.has("run.sh")) {
      log.push({ attempt, error: `нет run.sh или плохие имена: ${bad.join(", ")}` });
      break;
    }
    // Файл с собственным местом вывода запускает раннер; если run.sh тоже его зовёт, вывод будет со второго запуска.
    const twice = outputs.filter(
      (n) =>
        n !== "run.sh" &&
        new RegExp(`\\b${n.replace(/[.]/g, "\\.")}\\b`).test(parsed.files.get("run.sh")!),
    );
    if (twice.length) log.push({ attempt, warning: `run.sh сам запускает ${twice.join(", ")}` });
    results = runStand(
      join(cfg.stand.base, project),
      project,
      parsed.files,
      outputs,
      deps.exec ?? shellExec,
      cfg.stand.pyRun,
    );
    log.push({
      attempt,
      rc: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.rc])),
    });
    const bad2 = failed(results);
    if (Object.keys(bad2).length === 0 || attempt === cfg.stand.maxFixes) break;
    const { system, user } = render(promptDirs, "fix", cfg, {
      files: [...parsed.files].map(([n, b]) => `### ${n}\n\`\`\`\n${b}\`\`\``).join("\n\n"),
      results: brief(bad2),
    });
    const fix = parseJson<{ cause?: string; files?: Record<string, string> }>(
      await llm.ask("fix", system, user, 24_000, draft.candidate_id),
    );
    log[log.length - 1].cause = fix.cause ?? "";
    for (const [name, body] of Object.entries(fix.files ?? {})) {
      if (parsed.files.has(name)) html = setFile(html, name, body);
    }
  }
  const ok = Object.keys(results).length > 0 && Object.keys(failed(results)).length === 0;
  if (ok) {
    html = setOutputs(
      html,
      Object.fromEntries(outputs.filter((n) => results[n]).map((n) => [n, results[n].out])),
    );
  }
  writeFileSync(paths.html, html);
  writeFileSync(join(paths.work, "run.json"), JSON.stringify({ ok, log, results }, null, 1));
  db.prepare("UPDATE candidates SET status = ? WHERE id = ?").run(
    ok ? "ran" : "run_failed",
    draft.candidate_id,
  );
  return ok;
}
