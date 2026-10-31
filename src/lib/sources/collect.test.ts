import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import { openState } from "../store/db.ts";
import { collect } from "./collect.ts";

const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}
sources:
  - {id: a, kind: blog, url: "https://a/rss"}
  - {id: b, kind: blog, url: "https://b/rss"}
  - {id: bad, kind: blog, url: "https://bad/rss"}
select: {keywords: [kafka]}
`);

const TEXT =
  "Kafka consumer group rebalance moves partitions between members when one joins or leaves, " +
  "and the new protocol in KIP-848 makes the broker drive assignment instead of the client";

const rss = (items: [string, string, string][]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
    .map(
      ([t, l, d]) =>
        `<item><title>${t}</title><link>${l}</link><description>${d}</description></item>`,
    )
    .join("")}</channel></rss>`;

const FEEDS: Record<string, string> = {
  "https://a/rss": rss([
    ["A", "https://ex.com/a/?utm_source=rss", TEXT],
    ["B", "https://ex.com/b", "short"],
  ]),
  "https://b/rss": rss([["copy", "https://mirror.org/x", TEXT]]),
};
const fetchFeed = async (url: string) => {
  if (!FEEDS[url]) throw new Error(`HTTP 404 ${url}\nподробности`);
  return FEEDS[url];
};

test("сбор: повтор не плодит, почти-дубль из другой ленты помечен, ошибка ленты не валит сбор", async () => {
  const db = openState(":memory:");
  const first = await collect(db, cfg, fetchFeed);
  assert.deepEqual(
    first.map((r) => [r.sourceId, r.total, r.added, r.dups, r.error ?? ""]),
    [
      ["a", 2, 2, 0, ""],
      ["b", 1, 1, 1, ""],
      ["bad", 0, 0, 0, "HTTP 404 https://bad/rss"],
    ],
  );
  const again = await collect(db, cfg, fetchFeed, new Set(["a"]));
  assert.equal(again[0].added, 0);
  const copy = db.prepare("SELECT status, dup_of FROM candidates WHERE source_id = 'b'").get() as {
    status: string;
    dup_of: number;
  };
  assert.equal(copy.status, "dup");
  assert.ok(copy.dup_of);
});

test("состояние: миграции идемпотентны", () => {
  const db = openState(":memory:");
  const n = db.prepare("SELECT count(*) AS n FROM _migrations").get() as { n: number };
  assert.equal(n.n, 1);
});
