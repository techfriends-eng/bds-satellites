import type { Db } from "../store/db.ts";
import { urlHash } from "./keys.ts";

/**
 * Сверка с bigdataschool.ru: кандидат, на который уже ссылается пост BDS, дальше не идёт.
 * Sitemap даёт только адреса постов, поэтому внешние ссылки берутся из публичного WP REST.
 * Первый раз — все посты (1855 на 2026-10-28, ~15 мин), дальше — изменённые после последней сверки.
 */
const HREF = /href="(https?:\/\/[^"]+)"/g;
// Страница по 20: сто постов с текстом WP отдаёт дольше минуты (прототип, 2026-10-28).
const PER_PAGE = 20;

type Post = { link: string; modified_gmt: string; content: { rendered: string } };
export type GetJson = (url: string) => Promise<{ body: unknown; totalPages: number }>;

export function externalLinks(html: string, ownHost: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(HREF)) {
    let host: string;
    try {
      host = new URL(m[1]).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host && host !== ownHost) out.add(m[1]);
  }
  return [...out];
}

export async function syncBds(db: Db, base: string, getJson: GetJson): Promise<number> {
  const ownHost = new URL(base).hostname.replace(/^www\./, "");
  const last = (
    db.prepare("SELECT max(modified) AS m FROM bds_posts").get() as { m: string | null }
  ).m;
  const params = new URLSearchParams({
    per_page: String(PER_PAGE),
    orderby: "modified",
    order: "asc",
    _fields: "link,modified_gmt,content",
  });
  // Секунда назад: посты с тем же modified могли не войти в прошлую страницу. Повтор безвреден.
  if (last)
    params.set(
      "modified_after",
      new Date(Date.parse(`${last}Z`) - 1000).toISOString().slice(0, 19),
    );
  const upsert = db.prepare("INSERT OR REPLACE INTO bds_posts (link, modified) VALUES (?, ?)");
  const clear = db.prepare("DELETE FROM bds_links WHERE post_link = ?");
  const link = db.prepare("INSERT OR IGNORE INTO bds_links (url_hash, post_link) VALUES (?, ?)");
  let updated = 0;
  for (let page = 1; ; page++) {
    params.set("page", String(page));
    const { body, totalPages } = await getJson(`${base}/wp-json/wp/v2/posts?${params}`);
    db.exec("BEGIN");
    for (const p of body as Post[]) {
      upsert.run(p.link, p.modified_gmt);
      clear.run(p.link);
      for (const url of externalLinks(p.content.rendered, ownHost)) link.run(urlHash(url), p.link);
      updated++;
    }
    db.exec("COMMIT");
    if (page >= totalPages) break;
  }
  return updated;
}

export function markBds(db: Db): number {
  const r = db
    .prepare(
      `UPDATE candidates SET status = 'bds',
         bds_post = (SELECT min(post_link) FROM bds_links l WHERE l.url_hash = candidates.url_hash)
       WHERE status = 'new' AND url_hash IN (SELECT url_hash FROM bds_links)`,
    )
    .run();
  return Number(r.changes);
}
