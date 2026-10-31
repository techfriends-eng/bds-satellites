import assert from "node:assert/strict";
import { test } from "node:test";
import { expandHome, parseSiteConfig } from "./site.ts";

const YAML = `
site: {id: kafka, domain: kafka-school.ru}
courses: [{title: DEVKI, path: /courses/apache-kafka-developers/}]
sources:
  - {id: aiven, kind: blog, title: Aiven, url: "https://aiven.io/blog/feed.xml"}
  - {id: ws, kind: blog, topical: true, url: "https://ws/rss.xml"}
  - {id: yt, kind: youtube, channel_id: UC1, enabled: false}
  - {id: yt2, kind: youtube, channel_id: UC2}
select: {keywords: [kafka]}
`;

test("конфиг: источники, выключенные пропущены, youtube в ленту, умолчания", () => {
  const cfg = parseSiteConfig(YAML);
  assert.equal(cfg.siteId, "kafka");
  assert.deepEqual(
    cfg.sources.map((s) => [s.id, s.topical]),
    [
      ["aiven", false],
      ["ws", true],
      ["yt2", false],
    ],
  );
  assert.equal(cfg.sources[2].url, "https://www.youtube.com/feeds/videos.xml?channel_id=UC2");
  assert.equal(cfg.select.perRun, 2);
  assert.equal(cfg.publish.status, "draft");
  assert.equal(cfg.bdsBase, "https://bigdataschool.ru");
});

test("конфиг: пустые ключи, повтор источника и автопубликация — ошибка", () => {
  assert.throws(() => parseSiteConfig(YAML.replace("[kafka]", "[]")), /keywords/);
  assert.throws(() => parseSiteConfig(YAML.replace("id: ws,", "id: aiven,")), /повторяется/);
  assert.throws(() => parseSiteConfig(`${YAML}publish: {status: publish}\n`), /только draft/);
});

test("~ раскрывается в дом пользователя", () => {
  assert.equal(
    expandHome("~/.config/sat/x.env", "/home/bds-sat-kafka"),
    "/home/bds-sat-kafka/.config/sat/x.env",
  );
  assert.equal(expandHome("/etc/x.env", "/h"), "/etc/x.env");
});
