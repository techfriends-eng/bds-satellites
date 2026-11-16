import assert from "node:assert/strict";
import { test } from "node:test";
import { openState } from "../store/db.ts";
import { abReport, formatAb } from "./ab.ts";

test("abReport: темы, первый проход, цена по варианту", () => {
  const db = openState(":memory:");
  const add = (id: number, variant: string, status: string) =>
    db
      .prepare(
        "INSERT INTO candidates (id, url_hash, url, source_id, kind, title, fetched_at, status, variant) VALUES (?, ?, 'u', 's', 'news', 't', 'x', ?, ?)",
      )
      .run(id, `h${id}`, status, variant);
  const call = (cid: number, stage: string, cost: number, variant: string | null) =>
    db
      .prepare(
        "INSERT INTO llm_calls (at, stage, model, candidate_id, cost_usd, variant) VALUES ('x', ?, 'm', ?, ?, ?)",
      )
      .run(stage, cid, cost, variant);
  add(1, "a", "ready");
  add(2, "a", "gate_failed");
  add(3, "b", "ready");
  call(1, "write", 0.1, "a");
  call(2, "write", 0.1, "a");
  call(3, "write", 0.02, "b");
  call(3, "fix", 0.01, "b");
  call(3, "review", 0.5, null); // общий этап — не в цене варианта
  const [a, b] = abReport(db);
  assert.deepEqual(
    { ...a, costUsd: +a.costUsd.toFixed(3) },
    {
      variant: "a",
      topics: 2,
      ready: 1,
      firstPass: 1,
      gateFailed: 1,
      runFailed: 0,
      published: 0,
      fixCalls: 0,
      costUsd: 0.2,
    },
  );
  assert.equal(b.firstPass, 0);
  assert.equal(b.fixCalls, 1);
  assert.equal(+b.costUsd.toFixed(3), 0.03);
  assert.match(formatAb([a, b]), /^a: тем 2, готово 1 \(с первого раза 1\)/);
  assert.equal(formatAb([]), "A/B: тем с вариантом нет");
});
