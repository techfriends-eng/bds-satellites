import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { htmlToArticleText, parseFeed, stripHtml } from "@techfriends-eng/toolkit/ingest";
import { JINA, jinaText, type FetchLogEntry, type GetHtml } from "./fetcher.ts";

/**
 * Текст исходника. Цепочка: ручной файл автора → лента → авторская лента Medium → прямой запрос →
 * r.jina.ai. Берём первый текст от MIN_SOURCE_WORDS слов. Меньше — статус unreadable: статья по анонсу
 * из ленты выходит пересказом заголовка (#9197 — 24 слова, #9167 — 18, #9170 — 30).
 */
export const SOURCE_LIMIT = 40_000;
export const MIN_SOURCE_WORDS = 300;

export type SourceRow = { id: number; url: string; summary: string; body?: string };
export type SourceDeps = { manualDir?: string; getHtml: GetHtml };
export type SourceResult = {
  text: string | null;
  via: string | null;
  words: number;
  log: FetchLogEntry[];
};

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Куда автор кладёт текст недоступной статьи. */
export function manualPath(manualDir: string, id: number): string {
  return join(manualDir, `${id}.md`);
}

/** Лента автора или издания: Medium отдаёт в ней текст целиком, а саму статью роботу закрывает. */
export function mediumFeedUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === "medium.com" || host === "www.medium.com") {
    const first = u.pathname.split("/").filter(Boolean)[0];
    return first ? `https://medium.com/feed/${first}` : null;
  }
  return host.endsWith(".medium.com") ? `https://${host}/feed` : null;
}

/** У статьи Medium адрес бывает разным, постоянен шестнадцатеричный хвост. */
function mediumPostId(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
  return path.match(/-([0-9a-f]{8,})$/)?.[1] ?? path;
}

export async function readSource(row: SourceRow, deps: SourceDeps): Promise<SourceResult> {
  const log: FetchLogEntry[] = [];
  let best = 0;
  /** true — текст годится; в журнал идёт всё, что пробовали. */
  const accept = (step: string, raw: string): SourceResult | null => {
    const text = raw.replace(/[ \t]+/g, " ").trim();
    const words = wordCount(text);
    best = Math.max(best, words);
    if (words < MIN_SOURCE_WORDS) {
      log.push({ url: step, result: `мало текста (${words} слов)` });
      return null;
    }
    log.push({ url: step, result: `${words} слов` });
    return { text: text.slice(0, SOURCE_LIMIT), via: step, words, log };
  };
  const failed = (step: string, err: unknown) =>
    log.push({
      url: step,
      result: String((err as Error).message)
        .split("\n")[0]
        .slice(0, 120),
    });

  if (deps.manualDir) {
    const path = manualPath(deps.manualDir, row.id);
    if (existsSync(path)) {
      const ok = accept("ручной файл", readFileSync(path, "utf8"));
      if (ok) return ok;
    }
  }

  const feed = accept("лента", stripHtml(row.body || row.summary));
  if (feed) return feed;

  const mediumFeed = mediumFeedUrl(row.url);
  if (mediumFeed) {
    try {
      const id = mediumPostId(row.url);
      const item = parseFeed(await deps.getHtml(mediumFeed)).find(
        (i) => mediumPostId(i.url) === id,
      );
      if (item) {
        const ok = accept(mediumFeed, item.body);
        if (ok) return ok;
      } else {
        log.push({ url: mediumFeed, result: "статьи нет в ленте" });
      }
    } catch (err) {
      failed(mediumFeed, err);
    }
  }

  try {
    const ok = accept(row.url, htmlToArticleText(await deps.getHtml(row.url)));
    if (ok) return ok;
  } catch (err) {
    failed(row.url, err);
  }

  try {
    const ok = accept(JINA, jinaText(await deps.getHtml(`${JINA}${row.url}`)));
    if (ok) return ok;
  } catch (err) {
    failed(JINA, err);
  }

  return { text: null, via: null, words: best, log };
}
