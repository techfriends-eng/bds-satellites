import { stripHtml } from "@techfriends-eng/toolkit/ingest";
import type { SiteConfig } from "../config/site.ts";
import { parseJson, type Llm } from "../llm/client.ts";
import { render } from "../prompts/render.ts";
import { nowIso, type Db } from "../store/db.ts";

/** Отбор через LLM: оценка пула один раз на кандидата и добор тем до select.perRun. */

const BATCH = 40;

type Scored = { id: number; relevance: number; depth: number; reason?: string };

export async function score(
  db: Db,
  cfg: SiteConfig,
  llm: Llm,
  promptsDir: string,
): Promise<number> {
  const rows = db
    .prepare(
      "SELECT id, source_id, kind, title, summary FROM candidates WHERE status = 'new' AND score_relevance IS NULL ORDER BY published DESC",
    )
    .all() as { id: number; source_id: string; kind: string; title: string; summary: string }[];
  const upd = db.prepare(
    "UPDATE candidates SET score_relevance = ?, score_depth = ?, score_reason = ?, scored_at = ? WHERE id = ?",
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const items = chunk.map((r) => ({
      id: r.id,
      source: r.source_id,
      kind: r.kind,
      title: r.title,
      summary: stripHtml(r.summary).replace(/\s+/g, " ").slice(0, 500),
    }));
    const { system, user } = render(promptsDir, "select", cfg, { items: JSON.stringify(items) });
    const answer = parseJson<Scored[]>(await llm.ask("select", system, user, 8000));
    const known = new Set(chunk.map((r) => r.id));
    const at = nowIso();
    for (const a of answer) {
      if (known.has(a.id))
        upd.run(
          Math.round(a.relevance),
          Math.round(a.depth),
          String(a.reason ?? "").slice(0, 500),
          at,
          a.id,
        );
    }
  }
  return rows.length;
}

/** Добирает темы до perRun с учётом незаконченных (picked, drafted) из прошлых запусков. */
export function pick(db: Db, cfg: SiteConfig): number[] {
  const busy = (
    db
      .prepare("SELECT count(*) AS n FROM candidates WHERE status IN ('picked', 'drafted')")
      .get() as { n: number }
  ).n;
  const room = cfg.select.perRun - busy;
  if (room <= 0) return [];
  const ids = (
    db
      .prepare(
        `SELECT id FROM candidates WHERE status = 'new' AND score_relevance >= ? AND score_depth >= ?
         ORDER BY score_relevance + score_depth DESC, published DESC LIMIT ?`,
      )
      .all(cfg.select.minRelevance, cfg.select.minDepth, room) as { id: number }[]
  ).map((r) => r.id);
  const mark = db.prepare("UPDATE candidates SET status = 'picked' WHERE id = ?");
  for (const id of ids) mark.run(id);
  return ids;
}
