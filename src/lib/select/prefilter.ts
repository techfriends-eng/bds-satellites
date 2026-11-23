import { stripHtml } from "@techfriends-eng/toolkit/ingest";
import { createTopicMatcher } from "@techfriends-eng/toolkit/filter";
import type { SiteConfig } from "../config/site.ts";
import { CANDIDATE_COLS, type Db } from "../store/db.ts";

/**
 * Предотбор без LLM: возраст, пререлизы, видео не с докладом, тема. Отсеянное получает status = skip
 * и причину.
 */

const PRERELEASE = /(?:\brc\d*\b|-rc\d*|alpha|beta|preview|snapshot|\bm\d+\b)/i;

/** YouTube Shorts: в ленте канала ссылка /shorts/<id>; в коротком ролике нет текста на статью. */
const SHORTS = /youtube\.com\/shorts\//i;

/**
 * Видео об организации, а не технический доклад: записи митапов и созвонов, анонсы конференций,
 * трансляции, вебинары, разговоры со спонсорами. Решение автора 2026-11-23: только доклады.
 */
export const ORG_VIDEO = new RegExp(
  [
    "\\bmeet-?ups?\\b",
    "\\bmeetings?\\b",
    "\\bnights?\\b",
    "\\bconferences?\\b",
    "\\bsummit (?:recap|highlights|trailer|opening|closing|announcement)",
    "\\bcommunity (?:sync|call|broadcast|update|meeting)",
    "\\bcontributors? (?:call|sync|meeting)",
    // Рабочие созвоны с датой: «Iceberg Index Support Sync 2026 11 09», «column updates sync Oct 6 2026».
    "\\bsync\\s+(?:\\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d)",
    // Безымянные куски трансляции: «Session 4».
    "^session \\d+$",
    "\\boffice hours\\b",
    "\\btown ?hall\\b",
    "\\bdemo day\\b",
    "\\blive ?stream",
    "\\bwebinar",
    "\\brecap\\b",
    "\\bhighlights\\b",
    "\\btrailer\\b",
    "\\bteaser\\b",
    "\\bopening (?:remarks|session)",
    "\\bclosing (?:remarks|session)",
    "\\bcall for (?:papers|proposals|speakers)",
    "\\bcfp\\b",
    "\\bsponsor",
    "\\ba conversation with\\b",
    "\\bsave the date\\b",
    "митап",
    "конференци",
    "вебинар",
  ].join("|"),
  "i",
);

type Row = {
  id: number;
  url: string;
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
  if (row.kind === "youtube") {
    if (SHORTS.test(row.url)) return "shorts";
    if (ORG_VIDEO.test(row.title)) return "org_video";
  }
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
