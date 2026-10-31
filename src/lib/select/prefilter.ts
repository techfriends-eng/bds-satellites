import { stripHtml } from "@techfriends-eng/toolkit/ingest";
import { createTopicMatcher } from "@techfriends-eng/toolkit/filter";
import type { SiteConfig } from "../config/site.ts";
import { CANDIDATE_COLS, type Db } from "../store/db.ts";

/** Предотбор без LLM: возраст, пререлизы, тема. Отсеянное получает status = skip и причину. */

const PRERELEASE = /(?:\brc\d*\b|-rc\d*|alpha|beta|preview|snapshot|\bm\d+\b)/i;

type Row = {
  id: number;
  kind: string;
  source_id: string;
  title: string;
  summary: string;
  published: string | null;
};

export function skipReason(
  row: Row,
  cfg: SiteConfig,
  matches: (text: string) => boolean,
  cutoffIso: string,
): string | null {
  if (row.published && row.published < cutoffIso) return "age";
  if (row.kind === "release") return PRERELEASE.test(row.title) ? "prerelease" : null;
  if (cfg.sources.find((s) => s.id === row.source_id)?.topical) return null;
  // Агрегаторы шумные: тема должна быть в заголовке. Блоги — в заголовке или анонсе.
  const text = row.kind === "aggregator" ? row.title : `${row.title} ${stripHtml(row.summary)}`;
  return matches(text) ? null : "topic";
}

export function prefilter(db: Db, cfg: SiteConfig, now = new Date()): Record<string, number> {
  const cutoff = new Date(now.getTime() - cfg.select.maxAgeDays * 86_400_000).toISOString();
  const matcher = createTopicMatcher({ site: cfg.select.keywords.map((k) => new RegExp(k, "i")) });
  const matches = (text: string) => matcher.match(text).length > 0;
  const rows = db
    .prepare(`SELECT ${CANDIDATE_COLS} FROM candidates WHERE status = 'new'`)
    .all() as Row[];
  const skip = db.prepare("UPDATE candidates SET status = 'skip', skip_reason = ? WHERE id = ?");
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const why = skipReason(row, cfg, matches, cutoff);
    if (why) skip.run(why, row.id);
    counts[why ?? "pass"] = (counts[why ?? "pass"] ?? 0) + 1;
  }
  return counts;
}
