import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripHtml } from "@techfriends-eng/toolkit/ingest";
import { splitAnswer } from "../article/html.ts";
import type { SiteConfig } from "../config/site.ts";
import { parseJson, Truncated, type Llm } from "../llm/client.ts";
import { render } from "../prompts/render.ts";
import { createFetcher, formatLog, type GetHtml } from "../research/fetcher.ts";
import { nowIso, type Db } from "../store/db.ts";
import type { Style } from "../style/rules.ts";

/**
 * Черновик: разведка исходника → план с вердиктом → документация → статья и метаданные.
 * Каталог черновика <drafts>/<slug>/: <slug>.html, <slug>_meta.md (их читает линтер, имена по B0),
 * служебное — в .work/ (разведка, ответы, журналы прогона и проверок).
 */
export const SOURCE_LIMIT = 40_000;
export const DOC_LIMIT = 30_000;

export type Plan = {
  verdict: "take" | "skip";
  why: string;
  slug: string;
  key: string;
  title: string;
  doc_urls?: string[];
  [k: string]: unknown;
};

export type Candidate = {
  id: number;
  url: string;
  title: string;
  summary: string;
  source_id: string;
  published: string | null;
};

export type DraftDeps = {
  db: Db;
  cfg: SiteConfig;
  llm: Llm;
  style: Style;
  promptDirs: string[];
  draftsDir: string;
  getHtml: GetHtml;
};

export function draftPaths(dir: string, slug: string) {
  return {
    dir,
    html: join(dir, `${slug}.html`),
    meta: join(dir, `${slug}_meta.md`),
    work: join(dir, ".work"),
    research: join(dir, ".work", "research.json"),
  };
}

export async function sourceText(row: Candidate, fetcher: ReturnType<typeof createFetcher>) {
  // Агрегаторы отдают в ленте весь текст: в веб за ним не ходим.
  const feed = stripHtml(row.summary).replace(/\s+/g, " ").trim();
  if (feed.split(" ").length > 400) return feed.slice(0, SOURCE_LIMIT);
  return (await fetcher.text(row.url, SOURCE_LIMIT)) ?? feed;
}

/** Возвращает каталог черновика или null, если план сказал «не брать» (status = rejected). */
export async function writeDraft(deps: DraftDeps, row: Candidate): Promise<string | null> {
  const { db, cfg, llm, style, promptDirs } = deps;
  const fetcher = createFetcher(cfg.select.maxFetches, deps.getHtml);
  const source = await sourceText(row, fetcher);
  const meta = JSON.stringify({
    title: row.title,
    url: row.url,
    source: row.source_id,
    published: row.published,
  });

  const p = render(promptDirs, "plan", cfg, { meta, source, sat_delta: style.satDelta });
  const plan = parseJson<Plan>(await llm.ask("plan", p.system, p.user, 8000, row.id));
  if (plan.verdict !== "take") {
    db.prepare("UPDATE candidates SET status = 'rejected', score_reason = ? WHERE id = ?").run(
      `план: ${plan.why ?? ""}`.slice(0, 500),
      row.id,
    );
    return null;
  }
  const slug = /^[a-z0-9_]+$/.test(plan.slug ?? "") ? plan.slug : `sat_${row.id}`;
  const docs: string[] = [];
  for (const url of (plan.doc_urls ?? []).slice(0, 3)) {
    const text = await fetcher.text(url, DOC_LIMIT);
    if (text) docs.push(`### ${url}\n${text}`);
  }
  const fetchLog = formatLog(fetcher.log);

  const paths = draftPaths(join(deps.draftsDir, slug), slug);
  mkdirSync(paths.work, { recursive: true });
  writeFileSync(
    paths.research,
    JSON.stringify({ source, docs: docs.join("\n\n"), fetchLog, plan }),
  );

  const w = render(promptDirs, "write", cfg, {
    slug,
    plan: JSON.stringify(plan, null, 1),
    meta,
    source,
    docs: docs.join("\n\n") || "(документацию получить не удалось)",
    fetch_log: fetchLog,
    style_guide: style.styleGuide,
    sat_delta: style.satDelta,
  });
  let answer: string;
  try {
    answer = await llm.ask("write", w.system, w.user, 40_000, row.id);
  } catch (err) {
    // Обрезанный ответ оплачен: сохраняем для разбора, кандидат остаётся picked.
    if (err instanceof Truncated) writeFileSync(join(paths.work, "write.partial.txt"), err.text);
    throw err;
  }
  const { article, meta: metaMd } = splitAnswer(answer);
  writeFileSync(paths.html, `${article}\n`);
  writeFileSync(paths.meta, `${metaMd}\n`);
  db.prepare("INSERT OR REPLACE INTO drafts (candidate_id, dir, created) VALUES (?, ?, ?)").run(
    row.id,
    paths.dir,
    nowIso(),
  );
  db.prepare("UPDATE candidates SET status = 'drafted' WHERE id = ?").run(row.id);
  return paths.dir;
}
