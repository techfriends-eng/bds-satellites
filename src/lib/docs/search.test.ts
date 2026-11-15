import assert from "node:assert/strict";
import test from "node:test";
import {
  docsForPlan,
  gatherFragments,
  planQueries,
  queryText,
  renderFragments,
  type Fragment,
  type Search,
} from "./search.ts";

const frag = (
  url: string,
  section: string,
  similarity: number,
  content = "x".repeat(100),
): Fragment => ({
  product: "kafka",
  version: "4.3.2",
  section,
  url,
  content,
  similarity,
});

test("queryText совпадает с правилом bds-docs-index", () => {
  assert.equal(
    queryText(" KRaft quorum "),
    "Instruct: Given a question about a software product, retrieve documentation passages that answer it\nQuery: KRaft quorum",
  );
});

test("planQueries: ключ, до 4 разделов, сравнение, без пустых и дублей", () => {
  assert.deepEqual(
    planQueries({
      key: "KRaft",
      outline: ["A", "KRaft", "Bb1", "Cc2", "Dd3", "Ee4"],
      comparison: "",
    }),
    ["KRaft", "Bb1", "Cc2"],
  );
});

test("gatherFragments: по каждому продукту, без повторов, сильнейшие первыми, в лимите", async () => {
  const calls: string[] = [];
  const search: Search = async (_v, text, p) => {
    calls.push(`${text}|${p.product}`);
    return [frag("u1", "A", text === "q1" ? 0.5 : 0.7), frag("u2", "B", 0.6)];
  };
  const out = await gatherFragments(
    ["q1", "q2"],
    {
      products: [
        { product: "kafka", version: "4.3.2" },
        { product: "debezium", version: "3.7.1.Final" },
      ],
      k: 4,
      maxChars: 150,
    },
    async (t) => t.map(() => [0]),
    search,
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(
    out.map((f) => [f.url, f.similarity]),
    [["u1", 0.7]],
  );
});

test("renderFragments: заголовок с версией и разделом, источник", () => {
  const text = renderFragments([frag("https://github.com/x", "Ops → KRaft", 0.6, "body")]);
  assert.match(text, /#### kafka 4\.3\.2 — Ops → KRaft\nИсточник: https:\/\/github\.com\/x\nbody/);
  assert.equal(renderFragments([]), "");
});

test("docsForPlan: без env или конфига — пусто, без сети", async () => {
  const cfg = { products: [{ product: "kafka", version: "4.3.2" }], k: 4, maxChars: 1000 };
  assert.equal(await docsForPlan({ key: "x" }, cfg, () => undefined, {}), "");
  assert.equal(
    await docsForPlan({ key: "x" }, null, () => undefined, {
      DOCS_DB_URL: "a",
      DOCS_OLLAMA_URL: "b",
    }),
    "",
  );
});

test("docsForPlan: база недоступна — пусто и запись в лог", async () => {
  const log: string[] = [];
  const out = await docsForPlan(
    { key: "KRaft" },
    { products: [{ product: "kafka", version: "4.3.2" }], k: 4, maxChars: 1000 },
    (m) => log.push(m),
    { DOCS_DB_URL: "postgresql://u:p@127.0.0.1:1/db", DOCS_OLLAMA_URL: "http://127.0.0.1:1" },
  );
  assert.equal(out, "");
  assert.match(log[0], /индекс документации недоступен/);
});
