import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jinaText } from "./fetcher.ts";
import { mediumFeedUrl, readSource, SOURCE_LIMIT } from "./source.ts";

const WORDS = "Kafka KRaft кворум контроллер метаданные ".repeat(70);
const page = `<html><body><article><p>${WORDS}</p></article></body></html>`;
const POST = "https://medium.com/@a/kraft-in-prod-a06c0e8e98fa?source=rss------apache_kafka-5";
const row = (over = {}) => ({ id: 7, url: "https://site.io/p", summary: "анонс", ...over });
const failAll = async (u: string) => Promise.reject(new Error(`HTTP 403 ${u}`));

test("адрес ленты Medium: автор, издание, поддомен; чужой сайт — нет", () => {
  assert.equal(mediumFeedUrl(POST), "https://medium.com/feed/@a");
  assert.equal(mediumFeedUrl("https://medium.com/pub/x-1"), "https://medium.com/feed/pub");
  assert.equal(mediumFeedUrl("https://bob.medium.com/x-1"), "https://bob.medium.com/feed");
  assert.equal(mediumFeedUrl("https://site.io/p"), null);
});

test("ответ r.jina.ai: служебный заголовок снят, предупреждение об ошибке — пустой текст", () => {
  assert.equal(jinaText("Title: t\nURL Source: u\nMarkdown Content:\nтело").trim(), "тело");
  assert.equal(jinaText("Warning: Target URL returned error 403: Forbidden\nтело"), "");
});

test("чтение: полная лента — в сеть не ходим", async () => {
  const r = await readSource(row({ body: WORDS }), { getHtml: failAll });
  assert.equal(r.via, "лента");
  assert.ok(r.text);
});

test("чтение: ручной файл автора важнее всего", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sat-"));
  writeFileSync(join(dir, "7.md"), WORDS);
  const r = await readSource(row({ body: "мало" }), { manualDir: dir, getHtml: failAll });
  assert.equal(r.via, "ручной файл");
});

test("чтение: Medium закрыт, текст из авторской ленты по хвосту адреса", async () => {
  const feed = `<rss><channel>
    <item><title>Другая</title><link>https://medium.com/@a/other-b1b1b1b1b1b1</link>
      <content:encoded><![CDATA[<p>${WORDS}</p>]]></content:encoded></item>
    <item><title>KRaft</title><link>https://medium.com/@a/kraft-in-prod-a06c0e8e98fa?source=rss-1</link>
      <content:encoded><![CDATA[<p>нужная ${WORDS}</p>]]></content:encoded></item>
  </channel></rss>`;
  const r = await readSource(row({ url: POST }), {
    getHtml: async (u) => (u === "https://medium.com/feed/@a" ? feed : failAll(u)),
  });
  assert.equal(r.via, "https://medium.com/feed/@a");
  assert.match(r.text!, /^нужная/);
});

test("чтение: прямой запрос закрыт — запасной читатель", async () => {
  const r = await readSource(row(), {
    getHtml: async (u) =>
      u.startsWith("https://r.jina.ai/") ? `Markdown Content:\n${WORDS}` : failAll(u),
  });
  assert.equal(r.via, "https://r.jina.ai/");
});

test("чтение: заглушка на 200 не считается текстом, всё закрыто — text null и журнал", async () => {
  const r = await readSource(row({ summary: "анонс из двух слов" }), {
    getHtml: async (u) => (u === "https://site.io/p" ? "<p>Just a moment</p>" : failAll(u)),
  });
  assert.equal(r.text, null);
  assert.equal(r.words, 4);
  assert.deepEqual(
    r.log.map((e) => e.url),
    ["лента", "https://site.io/p", "https://r.jina.ai/"],
  );
  assert.match(r.log[2].result, /403/);
});

test("чтение: страница с текстом от порога проходит", async () => {
  const r = await readSource(row(), { getHtml: async () => page });
  assert.equal(r.via, "https://site.io/p");
});

test("чтение: длинная статья с прямого запроса не режется на 24 000 знаков", async () => {
  const html = `<article>${"слово ".repeat(10_000)}</article>`;
  const r = await readSource(row({ url: "https://habr.com/ru/articles/1/" }), {
    getHtml: async () => html,
  });
  assert.equal(r.text?.length, SOURCE_LIMIT);
});
