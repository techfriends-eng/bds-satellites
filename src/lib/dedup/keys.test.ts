import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupUrl, distance, simhash, urlHash, words } from "./keys.ts";

test("ключ URL: utm, хвосты лент, www, слэш, порядок параметров", () => {
  assert.equal(
    dedupUrl("https://WWW.Ex.com/a/?utm_source=x&b=2&a=1#top"),
    "https://ex.com/a?a=1&b=2",
  );
  assert.equal(
    urlHash("https://ex.com/a/"),
    urlHash("http://www.ex.com/a?utm_medium=rss&source=rss"),
  );
});

test("ключ URL: видео YouTube в любом виде — один ключ", () => {
  assert.equal(
    dedupUrl("https://www.youtube.com/watch?v=abc&t=10"),
    "https://youtube.com/watch?v=abc",
  );
  assert.equal(dedupUrl("https://youtu.be/abc"), "https://youtube.com/watch?v=abc");
});

const TEXT =
  "Kafka consumer group rebalance moves partitions between members when one joins or leaves, " +
  "and the new protocol in KIP-848 makes the broker drive assignment instead of the client";

test("simhash: почти-дубль близко, другой текст далеко", () => {
  const a = simhash(words(TEXT));
  assert.ok(distance(a, simhash(words(`${TEXT} today`))) <= 6);
  const other =
    "Spark structured streaming watermark drops late rows after the threshold passes ".repeat(2);
  assert.ok(distance(a, simhash(words(other))) > 10);
});

test("слова: теги отброшены, кириллица и цифры остаются", () => {
  assert.deepEqual(words("<p>Kafka 4.3 — кластер</p>"), ["kafka", "4", "3", "кластер"]);
});
