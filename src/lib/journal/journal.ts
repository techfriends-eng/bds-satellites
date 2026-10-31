import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SiteConfig } from "../config/site.ts";
import { stripForText } from "../gates/checks.ts";
import type { GatesReport } from "../gates/run.ts";
import { words } from "../dedup/keys.ts";
import { CANDIDATE_COLS, type Db } from "../store/db.ts";

/**
 * Журнал для BDS Хаба: статьи и прогоны в базе sat на auto08 (sat_writer, только с progon).
 * Хаб читает её через FDW на supan8n (RUNBOOK stack-radar §5). Недоступна база — предупреждение,
 * прогон не падает: журнал не причина терять статьи.
 */
export type Query = (sql: string, params: unknown[]) => Promise<unknown>;

const UPSERT = `
INSERT INTO sat.articles (site, candidate_id, title, source_url, source_id, status, words, gates_ok, gates,
                          review_high, review_medium, wp_post_id, wp_url, wp_status, cost_usd, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
ON CONFLICT (site, candidate_id) DO UPDATE SET
  title = EXCLUDED.title, status = EXCLUDED.status, words = EXCLUDED.words, gates_ok = EXCLUDED.gates_ok,
  gates = EXCLUDED.gates, review_high = EXCLUDED.review_high, review_medium = EXCLUDED.review_medium,
  wp_post_id = COALESCE(EXCLUDED.wp_post_id, sat.articles.wp_post_id),
  wp_url = COALESCE(EXCLUDED.wp_url, sat.articles.wp_url),
  wp_status = COALESCE(EXCLUDED.wp_status, sat.articles.wp_status),
  cost_usd = EXCLUDED.cost_usd, updated_at = now()`;

export function articleRow(db: Db, cfg: SiteConfig, candidateId: number): unknown[] {
  const c = db
    .prepare(`SELECT ${CANDIDATE_COLS} FROM candidates WHERE id = ?`)
    .get(candidateId) as Record<string, unknown>;
  const d = db.prepare("SELECT * FROM drafts WHERE candidate_id = ?").get(candidateId) as
    | Record<string, unknown>
    | undefined;
  const cost = (
    db
      .prepare("SELECT coalesce(sum(cost_usd), 0) AS c FROM llm_calls WHERE candidate_id = ?")
      .get(candidateId) as {
      c: number;
    }
  ).c;
  let title = String(c.title);
  let wordCount: number | null = null;
  let report: GatesReport | null = null;
  if (d) {
    const dir = String(d.dir);
    const slug = dir.split("/").pop()!;
    const html = join(dir, `${slug}.html`);
    const meta = join(dir, `${slug}_meta.md`);
    if (existsSync(meta))
      title =
        readFileSync(meta, "utf8")
          .match(/\*\*Заголовок статьи:\*\*\s*(.+)/)?.[1]
          .trim() ?? title;
    if (existsSync(html)) wordCount = words(stripForText(readFileSync(html, "utf8"))).length;
    const g = join(dir, ".work", "gates.json");
    if (existsSync(g)) report = JSON.parse(readFileSync(g, "utf8")) as GatesReport;
  }
  const sev = (s: string) => (report ? report.review.filter((i) => i.severity === s).length : null);
  return [
    cfg.siteId,
    candidateId,
    title,
    c.url,
    c.source_id,
    c.status,
    wordCount,
    report ? report.ok : null,
    report ? JSON.stringify(report.checks) : null,
    sev("high"),
    sev("medium"),
    d?.wp_post_id ?? null,
    d?.wp_url ?? null,
    d?.wp_status ?? null,
    Math.round(cost * 1000) / 1000,
  ];
}

export function createJournal(db: Db, cfg: SiteConfig, command: string) {
  const started = new Date();
  const touched = new Set<number>();
  const stats: Record<string, unknown> = { command };
  return {
    stats,
    touch: (id: number) => touched.add(id),
    async close(query: Query | null, costUsd: number, error: string | null = null): Promise<void> {
      if (!query) return;
      try {
        for (const id of [...touched].sort((a, b) => a - b))
          await query(UPSERT, articleRow(db, cfg, id));
        await query(
          "INSERT INTO sat.runs (site, started_at, finished_at, stats, cost_usd, error) VALUES ($1, $2, now(), $3, $4, $5)",
          [
            cfg.siteId,
            started.toISOString(),
            JSON.stringify(stats),
            Math.round(costUsd * 1000) / 1000,
            error,
          ],
        );
      } catch (err) {
        console.error(`журнал: не записан, ${(err as Error).message.split("\n")[0]}`);
      }
    },
  };
}

export type Journal = ReturnType<typeof createJournal>;
