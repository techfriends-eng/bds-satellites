import { parseFeed, type FeedItem } from "@techfriends-eng/toolkit/ingest";
import type { Source, SiteConfig } from "../config/site.ts";
import { distance, simhash, urlHash, words } from "../dedup/keys.ts";
import { nowIso, type Db } from "../store/db.ts";

/** Сбор лент сайта в пул кандидатов. Одна лента с ошибкой не валит сбор. */

export type FeedResult = {
  sourceId: string;
  total: number;
  added: number;
  dups: number;
  error?: string;
};
export type FetchFeed = (url: string, timeoutMs: number) => Promise<string>;

export function storeItems(db: Db, cfg: SiteConfig, src: Source, items: FeedItem[]): FeedResult {
  const res: FeedResult = { sourceId: src.id, total: items.length, added: 0, dups: 0 };
  const { simhashMaxDistance, simhashMinWords } = cfg.collect;
  // Сверяем только с другими лентами: внутри одной ленты похожи серии (патч-релизы), а не копии.
  const others = db.prepare(
    "SELECT id, simhash FROM candidates WHERE simhash IS NOT NULL AND dup_of IS NULL AND source_id != ?",
  );
  others.setReadBigInts(true);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO candidates
       (url_hash, url, source_id, kind, title, summary, published, fetched_at, simhash, dup_of, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    if (!item.url) continue;
    const summary = item.summary || item.body || "";
    const tokens = words(`${item.title} ${summary}`);
    const fp = tokens.length >= simhashMinWords ? simhash(tokens) : null;
    let dupOf: number | null = null;
    if (fp !== null) {
      for (const row of others.all(src.id) as { id: bigint; simhash: bigint }[]) {
        if (distance(fp, row.simhash) <= simhashMaxDistance) {
          dupOf = Number(row.id);
          break;
        }
      }
    }
    const r = insert.run(
      urlHash(item.url),
      item.url,
      src.id,
      src.kind,
      item.title.trim(),
      summary,
      item.publishedAt,
      nowIso(),
      fp,
      dupOf,
      dupOf ? "dup" : "new",
    );
    if (r.changes) {
      res.added++;
      if (dupOf) res.dups++;
    }
  }
  return res;
}

export async function collect(
  db: Db,
  cfg: SiteConfig,
  fetchFeed: FetchFeed,
  only?: Set<string>,
): Promise<FeedResult[]> {
  const results: FeedResult[] = [];
  const log = db.prepare(
    "INSERT INTO feed_runs (at, source_id, total, new, dups, error) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const src of cfg.sources) {
    if (only && !only.has(src.id)) continue;
    let res: FeedResult;
    try {
      res = storeItems(db, cfg, src, parseFeed(await fetchFeed(src.url, cfg.collect.timeoutMs)));
    } catch (err) {
      res = {
        sourceId: src.id,
        total: 0,
        added: 0,
        dups: 0,
        error: String((err as Error).message)
          .split("\n")[0]
          .slice(0, 300),
      };
    }
    log.run(nowIso(), res.sourceId, res.total, res.added, res.dups, res.error ?? null);
    results.push(res);
  }
  return results;
}
