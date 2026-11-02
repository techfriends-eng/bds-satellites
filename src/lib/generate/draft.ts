import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitAnswer } from "../article/html.ts";
import type { SiteConfig } from "../config/site.ts";
import { parseJson, Truncated, type Llm } from "../llm/client.ts";
import { render } from "../prompts/render.ts";
import { createFetcher, docUrlAllowed, formatLog, type GetHtml } from "../research/fetcher.ts";
import { manualPath, MIN_SOURCE_WORDS, readSource, wordCount } from "../research/source.ts";
import { nowIso, type Db } from "../store/db.ts";
import type { Style } from "../style/rules.ts";

/**
 * Черновик: разведка исходника → план с вердиктом → документация → статья и метаданные.
 * Каталог черновика <drafts>/<slug>/: <slug>.html, <slug>_meta.md (их читает линтер, имена по B0),
 * служебное — в .work/ (разведка, ответы, журналы прогона и проверок).
 */
export const DOC_LIMIT = 30_000;
// Статья целиком с кодом: рассуждение Sonnet 5.5 на effort medium съедало до 21k из 40k, и статья
// с большим примером обрывалась (python 1611). Потолок модели — 128k.
export const ARTICLE_MAX_TOKENS = 64_000;

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
  body?: string;
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
  /** Тексты от автора: <manualDir>/<id кандидата>.md (RUNBOOK §5). */
  manualDir?: string;
  getHtml: GetHtml;
};

type Research = { source: string; docs: string; fetchLog: string; plan: Plan };

/** Разведка с планом до готового черновика: если write упал, следующий прогон не платит за план снова. */
export function researchCachePath(draftsDir: string, candidateId: number) {
  return join(draftsDir, ".plans", `${candidateId}.json`);
}

export function draftPaths(dir: string, slug: string) {
  return {
    dir,
    html: join(dir, `${slug}.html`),
    meta: join(dir, `${slug}_meta.md`),
    work: join(dir, ".work"),
    research: join(dir, ".work", "research.json"),
  };
}

/** Статус unreadable: что пробовали и куда автору положить текст. Журнал и повтор — в pipeline.ts. */
function markUnreadable(deps: DraftDeps, row: Candidate, words: number, tried: string): void {
  const where = deps.manualDir ? manualPath(deps.manualDir, row.id) : "ручной файл";
  deps.db
    .prepare("UPDATE candidates SET status = 'unreadable', skip_reason = ? WHERE id = ?")
    .run(`нужен текст от автора в ${where}; ${words} слов; ${tried}`.slice(0, 500), row.id);
}

/**
 * Возвращает каталог черновика или null: план сказал «не брать» (status = rejected) либо текст исходника
 * получить не удалось (status = unreadable). LLM в последнем случае не вызывается.
 */
export async function writeDraft(deps: DraftDeps, row: Candidate): Promise<string | null> {
  const { db, cfg, llm, style, promptDirs } = deps;
  const meta = JSON.stringify({
    title: row.title,
    url: row.url,
    source: row.source_id,
    published: row.published,
  });
  const cachePath = researchCachePath(deps.draftsDir, row.id);
  let research: Research;
  // Кэш до v0.1.18 мог держать план по анонсу из ленты: такой план не годится.
  const cached = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, "utf8")) as Research)
    : null;
  if (cached && wordCount(cached.source) >= MIN_SOURCE_WORDS) {
    research = cached;
  } else {
    const fetcher = createFetcher(cfg.select.maxFetches, deps.getHtml);
    const read = await readSource(row, deps);
    fetcher.log.push(...read.log);
    if (read.text === null) {
      markUnreadable(deps, row, read.words, formatLog(read.log).replace(/\n/g, " "));
      rmSync(cachePath, { force: true });
      return null;
    }
    const source = read.text;
    const p = render(promptDirs, "plan", cfg, { meta, source, sat_delta: style.satDelta });
    const plan = parseJson<Plan>(await llm.ask("plan", p.system, p.user, 8000, row.id));
    if (plan.verdict !== "take") {
      db.prepare("UPDATE candidates SET status = 'rejected', score_reason = ? WHERE id = ?").run(
        `план: ${plan.why ?? ""}`.slice(0, 500),
        row.id,
      );
      return null;
    }
    const docs: string[] = [];
    for (const url of (plan.doc_urls ?? []).slice(0, 3)) {
      if (!docUrlAllowed(cfg.docs, url)) {
        fetcher.log.push({ url, result: "адрес вне разделов документации из конфига" });
        continue;
      }
      const text = await fetcher.text(url, DOC_LIMIT);
      if (text) docs.push(`### ${url}\n${text}`);
    }
    research = { source, docs: docs.join("\n\n"), fetchLog: formatLog(fetcher.log), plan };
    mkdirSync(join(deps.draftsDir, ".plans"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(research));
  }
  const { source, docs, plan } = research;
  const slug = /^[a-z0-9_]+$/.test(plan.slug ?? "") ? plan.slug : `sat_${row.id}`;

  const paths = draftPaths(join(deps.draftsDir, slug), slug);
  mkdirSync(paths.work, { recursive: true });
  writeFileSync(paths.research, JSON.stringify(research));

  const w = render(promptDirs, "write", cfg, {
    slug,
    plan: JSON.stringify(plan, null, 1),
    meta,
    source,
    docs: docs || "(нет)",
    style_guide: style.styleGuide,
    sat_delta: style.satDelta,
  });
  let answer: string;
  try {
    answer = await llm.ask("write", w.system, w.user, ARTICLE_MAX_TOKENS, row.id);
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
  rmSync(cachePath, { force: true });
  return paths.dir;
}
