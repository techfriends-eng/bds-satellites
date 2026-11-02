import { htmlToArticleText } from "@techfriends-eng/toolkit/ingest";
import type { DocSource } from "../config/site.ts";

/**
 * Разведка: текст исходника и документации с лимитом обращений к вебу на кандидата.
 * Страница короче MIN_TEXT символов — оглавление или JS-заглушка, в журнал пишется «пусто», а не
 * «200»: иначе текст статьи и журнал противоречат друг другу (kafka.apache.org/documentation/#kraft).
 * Заглушка с meta refresh разворачивается одним переходом. Пустая страница или ошибка: второй заход через
 * r.jina.ai. Обращением считается один адрес, запасной заход лимит не тратит.
 */
export const MIN_TEXT = 300;
const META_REFRESH =
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i;

/** Запасной читатель: отдаёт страницу текстом, в том числе с JS и там, где роботу закрыто. */
export const JINA = "https://r.jina.ai/";

/** Ответ r.jina.ai: заголовок служебный, сбой сайта приходит с кодом 200 и предупреждением. */
export function jinaText(answer: string): string {
  if (/^Warning: Target URL returned error/m.test(answer)) return "";
  const body = answer.match(/^Markdown Content:\s*$/m);
  return body ? answer.slice(body.index! + body[0].length) : answer;
}

export type GetHtml = (url: string) => Promise<string>;
export type FetchLogEntry = { url: string; result: string };

function firstLine(err: unknown): string {
  return String((err as Error).message)
    .split("\n")[0]
    .slice(0, 120);
}

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
      let problem: string;
      try {
        let html = await getHtml(url);
        const refresh = html.slice(0, 5000).match(META_REFRESH);
        if (refresh) html = await getHtml(new URL(refresh[1], url).toString());
        const text = htmlToArticleText(html, limit);
        if (text.length >= MIN_TEXT) {
          log.push({ url, result: "200" });
          return text;
        }
        problem = `пусто (${text.length} симв.)`;
      } catch (err) {
        problem = firstLine(err);
      }
      try {
        const text = jinaText(await getHtml(`${JINA}${url}`))
          .trim()
          .slice(0, limit);
        if (text.length >= MIN_TEXT) {
          log.push({ url, result: `${problem}; r.jina.ai: ${text.length} симв.` });
          return text;
        }
        log.push({ url, result: `${problem}; r.jina.ai: пусто (${text.length} симв.)` });
      } catch (err) {
        log.push({ url, result: `${problem}; r.jina.ai: ${firstLine(err)}` });
      }
      return null;
    },
  };
}

/**
 * Версии и пути документации модель угадывает (Spark docs/3.5.3, kafka.apache.org/documentation/#kraft).
 * Сайт документации из конфига читаем только внутри разрешённых разделов. Прочие сайты — первоисточники.
 */
export function docUrlAllowed(docs: DocSource[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const bases = docs.map((d) => new URL(d.base)).filter((b) => b.host === u.host);
  return bases.length === 0 || bases.some((b) => u.pathname.startsWith(b.pathname));
}

export function formatLog(log: FetchLogEntry[]): string {
  return log.length
    ? log.map((e) => `- ${e.url} — ${e.result}`).join("\n")
    : "- (веб не понадобился)";
}
