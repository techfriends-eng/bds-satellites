import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import { render } from "./render.ts";

const cfg = parseSiteConfig(
  "site: {id: kafka, domain: kafka-school.ru}\nselect: {keywords: [kafka]}\n",
);
const dir = join(import.meta.dirname, "__fixtures__");

test("промпт: подстановка, буквальные скобки, дополнение сайта, JSON в данных не портится", () => {
  const { system, user } = render([dir, join(dir, "site")], "t", cfg, {
    items: '[{"a": {"b": 1}}]',
  });
  assert.equal(
    system,
    'Сайт kafka-school.ru. Пример {"id": 1}.\n\nТолько про Kafka на kafka-school.ru.',
  );
  assert.equal(user, '[{"a": {"b": 1}}]');
});
