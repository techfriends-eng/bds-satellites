import { htmlToArticleText } from "@techfriends-eng/toolkit/ingest";

/**
 * Разведка: текст исходника и документации с лимитом обращений к вебу на кандидата.
 * Страница короче MIN_TEXT символов — оглавление или JS-заглушка, в журнал пишется «пусто», а не
 * «200»: иначе текст статьи и журнал противоречат друг другу (kafka.apache.org/documentation/#kraft).
 * Заглушка с meta refresh разворачивается одним переходом.
 */
export const MIN_TEXT = 300;
const META_REFRESH =
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i;

export type GetHtml = (url: string) => Promise<string>;
export type FetchLogEntry = { url: string; result: string };

export function createFetcher(maxFetches: number, getHtml: GetHtml) {
  let left = maxFetches;
  const log: FetchLogEntry[] = [];
  return {
    log,
    async text(url: string, limit: number): Promise<string | null> {
      if (left <= 0) {
        log.push({ url, result: "лимит обращений" });
        return null;
      }
      left--;
      let html: string;
      try {
        html = await getHtml(url);
        const refresh = html.slice(0, 5000).match(META_REFRESH);
        if (refresh) html = await getHtml(new URL(refresh[1], url).toString());
      } catch (err) {
        log.push({
          url,
          result: String((err as Error).message)
            .split("\n")[0]
            .slice(0, 120),
        });
        return null;
      }
      const text = htmlToArticleText(html).slice(0, limit);
      if (text.length < MIN_TEXT) {
        log.push({ url, result: `пусто (${text.length} симв.)` });
        return null;
      }
      log.push({ url, result: "200" });
      return text;
    },
  };
}

export function formatLog(log: FetchLogEntry[]): string {
  return log.length
    ? log.map((e) => `- ${e.url} — ${e.result}`).join("\n")
    : "- (веб не понадобился)";
}
