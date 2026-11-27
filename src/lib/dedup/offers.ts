import { stripHtml } from "@techfriends-eng/toolkit/ingest";
import type { SiteConfig } from "../config/site.ts";
import type { Query } from "../journal/journal.ts";
import type { Db } from "../store/db.ts";

/**
 * ADR 0005: лучшее со спутниковых лент сначала предлагается bigdataschool.ru. Кандидат с оценкой от
 * select.bdsMinRelevance / bdsMinDepth не идёт в черновик спутника: строка в `sat.bds_offers`, статус
 * `bds_offer`. Карточку с кнопками шлёт Stack Radar (трек «Лонгрид BDS») и пишет решение туда же.
 * Каждый отбор сверяет решения: approved — `radar` (материал у BDS), rejected/expired — `new`
 * (обычный отбор спутника), pending — ждёт. Ключ — url_hash: два спутника с одним материалом дают одно
 * предложение и читают одно решение. В режиме offers (конфиг `bds`, ADR 0005 п. 5) спутника нет:
 * rejected/expired — `skip` с `skip_reason = bds_declined`.
 */

export const BDS_DECLINED = "bds_declined";

/** Предложение, которое Stack Radar так и не показал, спутник через столько дней забирает сам. */
export const OFFER_FALLBACK_DAYS = 14;

export const OFFER_SELECT_SQL = `SELECT url_hash, status, offered_at FROM sat.bds_offers WHERE url_hash = ANY($1)`;

export const OFFER_INSERT_SQL = `INSERT INTO sat.bds_offers
  (site, candidate_id, url, url_hash, title, summary, source_id, source_kind, score_relevance, score_depth, reason)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (url_hash) DO NOTHING`;

type Row = {
  id: number;
  url_hash: string;
  url: string;
  source_id: string;
  kind: string;
  title: string;
  summary: string;
  score_relevance: number;
  score_depth: number;
  score_reason: string | null;
  status: string;
};

export type OfferStats = {
  offered: number;
  queued: number;
  pending: number;
  bds: number;
  returned: number;
};

export async function syncBdsOffers(
  db: Db,
  cfg: SiteConfig,
  query: Query,
  now = new Date(),
): Promise<OfferStats> {
  const { bdsMinRelevance, bdsMinDepth, bdsPerRun } = cfg.select;
  const rows = db
    .prepare(
      `SELECT id, url_hash, url, source_id, kind, title, summary, score_relevance, score_depth, score_reason, status
         FROM candidates
        WHERE status = 'bds_offer'
           OR (status = 'new' AND score_relevance >= ? AND score_depth >= ?)
        ORDER BY score_relevance + score_depth DESC, published DESC`,
    )
    .all(bdsMinRelevance, bdsMinDepth) as Row[];
  const stats: OfferStats = { offered: 0, queued: 0, pending: 0, bds: 0, returned: 0 };
  if (rows.length === 0) return stats;

  const res = (await query(OFFER_SELECT_SQL, [rows.map((r) => r.url_hash)])) as {
    rows: { url_hash: string; status: string; offered_at: string | Date }[];
  };
  const known = new Map(res.rows.map((r) => [r.url_hash, r]));
  const setStatus = db.prepare("UPDATE candidates SET status = ? WHERE id = ?");
  const decline = db.prepare(
    `UPDATE candidates SET status = 'skip', skip_reason = '${BDS_DECLINED}' WHERE id = ?`,
  );
  const fallback = now.getTime() - OFFER_FALLBACK_DAYS * 86_400_000;

  for (const r of rows) {
    const offer = known.get(r.url_hash);
    if (!offer) {
      // Ещё не предлагали (или строку снесли руками): предложить, не больше bdsPerRun за отбор.
      // Сверх лимита — очередь: статус bds_offer без строки, спутник её не берёт, предложит следующий отбор.
      if (stats.offered >= bdsPerRun) {
        if (r.status !== "bds_offer") setStatus.run("bds_offer", r.id);
        stats.queued++;
        continue;
      }
      await query(OFFER_INSERT_SQL, [
        cfg.siteId,
        r.id,
        r.url,
        r.url_hash,
        r.title,
        stripHtml(r.summary).replace(/\s+/g, " ").trim().slice(0, 1000),
        r.source_id,
        r.kind,
        r.score_relevance,
        r.score_depth,
        (r.score_reason ?? "").slice(0, 500),
      ]);
      setStatus.run("bds_offer", r.id);
      stats.offered++;
      continue;
    }
    if (offer.status === "approved") {
      setStatus.run("radar", r.id);
      stats.bds++;
    } else if (offer.status === "pending" && new Date(offer.offered_at).getTime() > fallback) {
      if (r.status !== "bds_offer") setStatus.run("bds_offer", r.id);
      stats.pending++;
    } else {
      // rejected, expired или не показан за OFFER_FALLBACK_DAYS: материал у спутника,
      // в режиме offers спутника нет — тема снята.
      if (cfg.mode === "offers") {
        decline.run(r.id);
        stats.returned++;
      } else if (r.status !== "new") {
        setStatus.run("new", r.id);
        stats.returned++;
      }
    }
  }
  return stats;
}
