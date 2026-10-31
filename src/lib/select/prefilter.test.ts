import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import { externalLinks, markBds, syncBds } from "../dedup/bds.ts";
import { urlHash } from "../dedup/keys.ts";
import { markRadar } from "../dedup/radar.ts";
import { openState } from "../store/db.ts";
import { prefilter } from "./prefilter.ts";

const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}
sources:
  - {id: aiven, kind: blog, url: "https://aiven/rss"}
  - {id: tags, kind: release, url: "https://gh/tags"}
  - {id: ws, kind: blog, topical: true, url: "https://ws/rss"}
  - {id: md, kind: aggregator, url: "https://md/rss"}
select: {keywords: [kafka, "\\\\bkraft\\\\b"]}
`);

function seed(rows: [string, string, string, string, string, string | null][]) {
  const db = openState(":memory:");
  const ins = db.prepare(
    "INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const [url, src, kind, title, summary, published] of rows)
    ins.run(urlHash(url), url, src, kind, title, summary, published, "2026-10-28T00:00:00Z");
  return db;
}

test("предотбор: возраст, пререлиз, тема по виду источника, topical без проверки", () => {
  const d = "2026-10-01T00:00:00Z";
  const db = seed([
    ["https://aiven/old", "aiven", "blog", "Kafka tiered storage", "", "2024-01-01T00:00:00Z"],
    ["https://aiven/pg", "aiven", "blog", "Welcome PostgreSQL 18", "", d],
    ["https://aiven/k", "aiven", "blog", "Diskless topics", "<p>Apache Kafka без дисков</p>", d],
    ["https://gh/rc", "tags", "release", "4.4.0-rc4", "", d],
    ["https://gh/432", "tags", "release", "4.3.2", "", d],
    ["https://ws/gc", "ws", "blog", "Garbage collection of object storage", "", d],
    ["https://md/x", "md", "aggregator", "My weekend", "about kafka inside", d],
  ]);
  // simhash из длинного текста — 64 бита: SELECT * с ним падал RangeError (дымовой прогон 2026-10-31)
  db.exec("UPDATE candidates SET simhash = 8397545936689959232 WHERE url = 'https://aiven/k'");
  const counts = prefilter(db, cfg, new Date("2026-10-28T00:00:00Z"));
  assert.deepEqual(counts, { age: 1, topic: 2, prerelease: 1, pass: 3 });
  const left = (
    db.prepare("SELECT url FROM candidates WHERE status = 'new' ORDER BY id").all() as {
      url: string;
    }[]
  ).map((r) => r.url);
  assert.deepEqual(left, ["https://aiven/k", "https://gh/432", "https://ws/gc"]);
});

test("BDS: свои ссылки отброшены, индекс страницами, кандидат со ссылкой из поста помечен", async () => {
  assert.deepEqual(
    externalLinks(
      '<a href="https://bigdataschool.ru/blog/x/">с</a><a href="https://ex.com/a?utm_source=tg">и</a>',
      "bigdataschool.ru",
    ),
    ["https://ex.com/a?utm_source=tg"],
  );
  const db = seed([["https://ex.com/a", "aiven", "blog", "A", "", null]]);
  const pages = [
    [
      {
        link: "https://bigdataschool.ru/p1/",
        modified_gmt: "2026-10-01T00:00:00",
        content: { rendered: '<a href="https://ex.com/a/">x</a>' },
      },
    ],
    [
      {
        link: "https://bigdataschool.ru/p2/",
        modified_gmt: "2026-10-02T00:00:00",
        content: { rendered: "" },
      },
    ],
  ];
  const urls: string[] = [];
  const n = await syncBds(db, "https://bigdataschool.ru", async (url) => {
    urls.push(url);
    return { body: pages[urls.length - 1], totalPages: 2 };
  });
  assert.equal(n, 2);
  assert.equal(markBds(db), 1);
  await syncBds(db, "https://bigdataschool.ru", async (url) => {
    urls.push(url);
    return { body: [], totalPages: 1 };
  });
  assert.match(urls[2], /modified_after=2026-10-01T23%3A59%3A59/);
});

test("Stack Radar: занятый основным контуром кандидат помечен radar", async () => {
  const db = seed([
    ["https://ex.com/a", "aiven", "blog", "A", "", null],
    ["https://ex.com/b", "aiven", "blog", "B", "", null],
  ]);
  assert.equal(await markRadar(db, async () => ["https://www.ex.com/b/?utm_source=x"]), 1);
  const st = db.prepare("SELECT status FROM candidates WHERE url = 'https://ex.com/b'").get() as {
    status: string;
  };
  assert.equal(st.status, "radar");
});

test("отбор: добор до perRun с учётом незаконченных тем", async () => {
  const { pick } = await import("./rank.ts");
  const db = seed([
    ["https://x/1", "aiven", "blog", "1", "", null],
    ["https://x/2", "aiven", "blog", "2", "", null],
    ["https://x/3", "aiven", "blog", "3", "", null],
  ]);
  db.exec("UPDATE candidates SET score_relevance = 9, score_depth = 9");
  db.exec("UPDATE candidates SET score_depth = 3 WHERE url = 'https://x/3'");
  db.exec("UPDATE candidates SET status = 'drafted' WHERE url = 'https://x/2'");
  assert.equal(pick(db, cfg).length, 1);
  assert.deepEqual(pick(db, cfg), []);
});
