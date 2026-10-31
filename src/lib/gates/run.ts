import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outputsOf, parseArticle, setOutputs, splitAnswer } from "../article/html.ts";
import { draftPaths } from "../generate/draft.ts";
import { parseJson } from "../llm/client.ts";
import { render } from "../prompts/render.ts";
import type { Style } from "../style/rules.ts";
import { checkDraft, type StandDeps } from "../stand/check.ts";
import { images, links, lint, uniqueness, type Check, type Head } from "./checks.ts";

/**
 * Проверки и переписывание. Линтер оформления, образы, ссылки, уникальность, смысловая проверка
 * (текст против реального вывода). Провал — переписывание по выводу, замечаниям и провалам линтера,
 * при смене кода — повторный прогон, не больше gates.maxRevisions кругов.
 */
export type Issue = { severity: string; quote: string; problem: string; fix?: string };
export type GatesReport = { ok: boolean; checks: Record<string, Check>; review: Issue[] };

export type GateDeps = StandDeps & { style: Style; lintPy: string; head: Head };
type Draft = { candidate_id: number; dir: string };

function research(dir: string): { source: string; docs: string; plan: { key?: string } } {
  const p = join(dir, ".work", "research.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { source: "", docs: "", plan: {} };
}

export async function review(
  deps: GateDeps,
  html: string,
  docs: string,
  candidateId: number,
): Promise<Issue[]> {
  const { system, user } = render(deps.promptDirs, "review", deps.cfg, {
    docs: docs || "(нет)",
    draft: html,
  });
  const issues =
    parseJson<{ issues?: Issue[] }>(await deps.llm.ask("review", system, user, 24_000, candidateId))
      .issues ?? [];
  // Без оценки — считаем серьёзным: сбой формата ответа не должен давать PASS.
  for (const i of issues) if (!["high", "medium", "low"].includes(i.severity)) i.severity = "high";
  return issues;
}

export async function gate(deps: GateDeps, draft: Draft, slug: string): Promise<GatesReport> {
  const { db, cfg } = deps;
  const paths = draftPaths(draft.dir, slug);
  const html = readFileSync(paths.html, "utf8");
  const cand = db.prepare("SELECT url FROM candidates WHERE id = ?").get(draft.candidate_id) as {
    url: string;
  };
  const r = research(draft.dir);
  const others: Record<string, string> = { исходник: r.source };
  for (const o of db
    .prepare("SELECT dir FROM drafts WHERE candidate_id != ?")
    .all(draft.candidate_id) as { dir: string }[]) {
    const name = o.dir.split("/").pop()!;
    const file = join(o.dir, `${name}.html`);
    if (existsSync(file)) others[name] = readFileSync(file, "utf8");
  }
  const lintRes = lint(deps.lintPy, draft.dir, slug, cfg.domain, r.plan.key || slug);
  const checks: Record<string, Check> = {
    lint: { ok: lintRes.ok, detail: lintRes.detail },
    code_ran: {
      ok: !html.includes("[[output"),
      detail: html.includes("[[output") ? "остались места вывода без вывода" : "вывод вставлен",
    },
    images: images(parseArticle(html).files, cfg),
    links: await links(html, cand.url, cfg.domain, deps.head),
    uniqueness: uniqueness(html, others, cfg.gates.maxShingleShare),
  };
  const issues = await review(deps, html, r.docs, draft.candidate_id);
  const high = issues.filter((i) => i.severity === "high").length;
  checks.review = { ok: high === 0, detail: `замечаний ${issues.length}, high ${high}` };
  const ok = Object.values(checks).every((c) => c.ok);
  const report: GatesReport = { ok, checks, review: issues };
  writeFileSync(join(paths.work, "gates.json"), JSON.stringify(report, null, 1));
  db.prepare("UPDATE candidates SET status = ? WHERE id = ?").run(
    ok ? "ready" : "gate_failed",
    draft.candidate_id,
  );
  return report;
}

/** Одна правка. true — изменился код (нужен новый прогон). */
export async function reviseOnce(deps: GateDeps, draft: Draft, slug: string): Promise<boolean> {
  const paths = draftPaths(draft.dir, slug);
  const html = readFileSync(paths.html, "utf8");
  const meta = readFileSync(paths.meta, "utf8");
  const report = JSON.parse(readFileSync(join(paths.work, "gates.json"), "utf8")) as GatesReport;
  const failedChecks = Object.entries(report.checks)
    .filter(([k, v]) => !v.ok && k !== "review")
    .map(([k, v]) => `- ${k}: ${v.detail}`)
    .join("\n");
  const { system, user } = render(deps.promptDirs, "revise", deps.cfg, {
    lint: failedChecks || "- нет",
    issues: JSON.stringify(
      report.review.filter((i) => i.severity !== "low"),
      null,
      1,
    ),
    docs: research(draft.dir).docs || "(нет)",
    article: html,
    meta_md: meta,
    style_guide: deps.style.styleGuide,
    sat_delta: deps.style.satDelta,
  });
  const next = splitAnswer(await deps.llm.ask("revise", system, user, 40_000, draft.candidate_id));
  const before = parseArticle(html);
  const after = parseArticle(next.article);
  const sameSet = (a: Iterable<string>, b: Iterable<string>) =>
    [...a].sort().join("\n") === [...b].sort().join("\n");
  if (
    !sameSet(before.files.keys(), after.files.keys()) ||
    !sameSet(before.outputs, after.outputs)
  ) {
    throw new Error("правка сменила набор файлов или мест вывода");
  }
  // Вывод — только настоящий: возвращаем прежние блоки вывода, что бы ни написала модель.
  writeFileSync(paths.html, `${setOutputs(next.article, outputsOf(html))}\n`);
  writeFileSync(paths.meta, `${next.meta}\n`);
  return [...before.files].some(([n, b]) => after.files.get(n) !== b);
}

/** До gates.maxRevisions кругов «переписать → (прогон) → проверки». true — статья прошла. */
export async function finish(deps: GateDeps, draft: Draft, slug: string): Promise<boolean> {
  for (let i = 0; i < deps.cfg.gates.maxRevisions; i++) {
    if (await reviseOnce(deps, draft, slug)) {
      if (!(await checkDraft(deps, draft, slug))) return false;
    }
    if ((await gate(deps, draft, slug)).ok) return true;
  }
  return false;
}

export function slugOf(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").pop()!;
}
