import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatClient, ChatRequest, ChatResult } from "@techfriends-eng/toolkit/llm";
import { parseSiteConfig } from "../config/site.ts";
import { openState } from "../store/db.ts";
import { BudgetExceeded, createLlm, parseJson, Truncated } from "./client.ts";

const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}
select: {keywords: [kafka]}
llm:
  models: {select: m-haiku, write: m-sonnet}
  reasoning: {write: {effort: medium}}
  maxCostPerRunUsd: 0.05
`);

function fakeChat(results: Partial<ChatResult>[]) {
  const seen: ChatRequest[] = [];
  const chat = {
    complete: async () => null,
    completeDetailed: async (req: ChatRequest) => {
      seen.push(req);
      const r = results.shift();
      return r
        ? {
            text: "ok",
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 2, reasoningTokens: 0, costUsd: 0.03 },
            ...r,
          }
        : null;
    },
  } satisfies ChatClient;
  return { chat, seen };
}

test("llm: модель и рассуждение этапа, журнал расхода, потолок прогона", async () => {
  const db = openState(":memory:");
  const { chat, seen } = fakeChat([{}, { finishReason: "length", text: "обрыв" }, {}]);
  const llm = createLlm(db, cfg, chat);
  assert.equal(await llm.ask("write", "s", "u", 100, 7), "ok");
  assert.equal(seen[0].model, "m-sonnet");
  assert.deepEqual(seen[0].body, { usage: { include: true }, reasoning: { effort: "medium" } });
  await assert.rejects(
    llm.ask("select", "s", "u", 100),
    (e: Error) => e instanceof Truncated && (e as Truncated).text === "обрыв",
  );
  assert.deepEqual(seen[1].body, { usage: { include: true } });
  await assert.rejects(llm.ask("select", "s", "u", 100), BudgetExceeded);
  const rows = db.prepare("SELECT stage, candidate_id, cost_usd FROM llm_calls ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(llm.spent() - 0.06) < 1e-9);
});

test("parseJson: код с ``` внутри строки, обёртка, текст вокруг", () => {
  const body = '{"cause": "x", "files": {"run.sh": "echo 1\\n```\\nnot json\\n```\\n"}}';
  assert.equal(parseJson<{ cause: string }>(body).cause, "x");
  assert.equal(parseJson<{ cause: string }>("```json\n" + body + "\n```").cause, "x");
  assert.equal(parseJson<{ cause: string }>("Вот:\n" + body + "\nГотово.").cause, "x");
  assert.throws(() => parseJson("нет json"), SyntaxError);
  // «Extra data»: после JSON второй объект (прототип, 2026-10-31) и скобки внутри строк
  assert.equal(parseJson<{ a: string }>('{"a": "x } ] \\" {"}\n{"b": 2}').a, 'x } ] " {');
});
