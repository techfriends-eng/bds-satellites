// Конфиг сайта разбирается пакетом и согласован с сайтом: домен, курсы, источники, модели.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const raw = parse(readFileSync(new URL("../config/site.yaml", import.meta.url), "utf8"));

test("сайт и домен заданы", () => {
  assert.equal(raw.site.id, "__SITE__");
  assert.equal(raw.site.domain, "__DOMAIN__");
});

test("курсы — пути сайта со слэшем на конце (Style Guide п. 12)", () => {
  for (const c of raw.courses ?? []) assert.match(c.path, /^\/courses\/[\w-]+\/$/, c.title);
});

test("источники: уникальные id, URL https, у youtube — channel_id", () => {
  const ids = new Set();
  for (const s of raw.sources ?? []) {
    assert.ok(!ids.has(s.id), `повтор ${s.id}`);
    ids.add(s.id);
    if (s.kind === "youtube") assert.ok(s.channel_id, s.id);
    else assert.match(s.url, /^https:\/\//, s.id);
  }
});

test("модели заданы для всех этапов, публикация только черновиком", () => {
  for (const stage of ["select", "plan", "write", "fix", "review", "revise", "image"]) {
    assert.ok(raw.llm.models[stage], stage);
  }
  assert.equal(raw.publish.status, "draft");
});
