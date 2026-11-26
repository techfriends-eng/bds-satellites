import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatHttpError,
  createLedger,
  type ChatClient,
  type ChatRequest,
  type ChatResult,
} from "@techfriends-eng/toolkit/llm";
import { parseSiteConfig } from "../config/site.ts";
import { openState } from "../store/db.ts";
import type { ClaudeCli } from "./claude-cli.ts";
import { BudgetExceeded, createLlm, parseJson, Truncated, weekSpent } from "./client.ts";

const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
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
            model: req.model,
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

test("llm: потолок недели — расход прошлых тактов плюс свой", async () => {
  const week = parseSiteConfig(
    `site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
select: {keywords: [kafka]}
llm: {models: {write: m}, maxCostPerRunUsd: 1, maxCostPerWeekUsd: 0.1}
`,
  );
  assert.equal(cfg.llm.maxCostPerWeekUsd, 0.05, "по умолчанию — потолок прогона");
  const db = openState(":memory:");
  const llm = createLlm(db, week, fakeChat([{}, {}]).chat, undefined, undefined, 0.08);
  assert.equal(await llm.ask("write", "s", "u", 100), "ok");
  assert.ok(llm.exhausted());
  await assert.rejects(
    llm.ask("write", "s", "u", 100),
    /потолок недели \$0\.1 исчерпан \(\$0\.110\)/,
  );
  // Без weekBase (команды автора) потолок недели не действует.
  const free = createLlm(db, week, fakeChat([{}]).chat, undefined, undefined, null);
  assert.ok(!free.exhausted());
});

test("weekSpent: в потолок недели идут только такты, ручные команды — нет", async () => {
  const db = openState(":memory:");
  const tick = createLlm(db, cfg, fakeChat([{}]).chat, undefined, undefined, 0, "tick");
  await tick.ask("write", "s", "u", 100);
  const rework = createLlm(db, cfg, fakeChat([{}]).chat, undefined, undefined, null, "rework");
  await rework.ask("write", "s", "u", 100);
  const rows = db.prepare("SELECT command, cost_usd FROM llm_calls ORDER BY id").all() as {
    command: string;
    cost_usd: number;
  }[];
  assert.deepEqual(
    rows.map((r) => r.command),
    ["tick", "rework"],
  );
  assert.equal(weekSpent(db, "1970-01-01T00:00:00Z"), rows[0].cost_usd);
  assert.ok(rows[0].cost_usd > 0);
  assert.equal(weekSpent(db, "2999-01-01T00:00:00Z"), 0);
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

test("расход картинки идёт в журнал и в потолок прогона", () => {
  const db = openState(":memory:");
  const llm = createLlm(db, cfg, fakeChat([]).chat);
  assert.equal(llm.exhausted(), false);
  llm.charge("image", "m-image", 0.06, 7);
  assert.equal(llm.spent(), 0.06);
  assert.equal(llm.exhausted(), true);
  const row = db.prepare("SELECT stage, model, candidate_id, cost_usd FROM llm_calls").get();
  assert.deepEqual(
    { ...(row as object) },
    { stage: "image", model: "m-image", candidate_id: 7, cost_usd: 0.06 },
  );
});

test("llm: общий журнал — строка на вызов и на картинку, сайт и кандидат, обрезанный — ok=false", async () => {
  const db = openState(":memory:");
  const { chat } = fakeChat([{ model: "anthropic/claude-sonnet-5.5" }, { finishReason: "length" }]);
  const rows: unknown[][] = [];
  const ledger = createLedger({
    project: "bds-satellites",
    query: async (_s, p) => void rows.push(p),
  });
  const llm = createLlm(db, { ...cfg, llm: { ...cfg.llm, maxCostPerRunUsd: 5 } }, chat, ledger);
  await llm.ask("write", "s", "u", 100, 7);
  await assert.rejects(llm.ask("select", "s", "u", 100), Truncated);
  llm.charge("image", "google/gemini-3-pro-image", 0.12, 7, false);
  await llm.flush();
  // project, stage, model, provider, site, ref, prompt, completion, reasoning, cost, cached, ok
  assert.deepEqual(rows[0].slice(0, 12), [
    "bds-satellites",
    "write",
    "anthropic/claude-sonnet-5.5",
    "openrouter",
    "kafka",
    "7",
    1,
    2,
    0,
    0.03,
    false,
    true,
  ]);
  assert.equal(rows[1][1], "select");
  assert.equal(rows[1][11], false);
  assert.deepEqual(rows[2].slice(0, 6), [
    "bds-satellites",
    "image",
    "google/gemini-3-pro-image",
    "openrouter",
    "kafka",
    "7",
  ]);
  assert.equal(rows[2][9], 0.12);
  assert.equal(rows[2][11], false);
});

test("llm: без журнала flush ничего не ждёт", async () => {
  const llm = createLlm(openState(":memory:"), cfg, fakeChat([{}]).chat);
  await llm.ask("select", "s", "u", 100);
  await llm.flush();
});

const multi = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
select: {keywords: [kafka]}
llm:
  models: {review: [claude-cli:sonnet, openrouter:m-sonnet, m-backup], write: m-sonnet}
  reasoning: {review: {effort: medium}}
  maxCostPerRunUsd: 5
`);

function fakeCli(gate: { ok: boolean; why: string }, fail = false) {
  const asks: { alias: string; effort?: string }[] = [];
  const cli = {
    allowed: async () => gate,
    ask: async (alias: string, _s: string, _u: string, effort?: string) => {
      asks.push({ alias, effort });
      if (fail) throw new Error("claude-cli: сбой");
      return {
        text: "по подписке",
        model: "claude-sonnet-5-5",
        truncated: false,
        usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0 as const },
      };
    },
  } satisfies ClaudeCli;
  return { cli, asks };
}

test("конфиг: модель строкой — список из одной, список — как есть, чужой бэкенд — ошибка", () => {
  assert.deepEqual(multi.llm.models.write, ["m-sonnet"]);
  assert.deepEqual(multi.llm.models.review, [
    "claude-cli:sonnet",
    "openrouter:m-sonnet",
    "m-backup",
  ]);
  assert.equal(multi.llm.claudeCli.fiveHourMax, 0.3);
  assert.throws(
    () => parseSiteConfig(multi_yaml("review: [ollama:host/qwen]")),
    /ollama не поддержан/,
  );
  assert.throws(
    () => parseSiteConfig(multi_yaml("image: [claude-cli:sonnet]")),
    /только OpenRouter/,
  );
  assert.throws(
    () => parseSiteConfig(multi_yaml("video: [claude-cli:sonnet]")),
    /llm.models.video: только OpenRouter/,
  );
  assert.deepEqual(multi.llm.models.video, ["google/gemini-2.5-flash"]);
});

function multi_yaml(models: string) {
  return `site: {id: kafka, domain: kafka-school.ru}
brand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
select: {keywords: [kafka]}
llm: {models: {${models}}}
`;
}

test("откат: подписка свободна — claude-cli, cost 0, provider claude-cli, effort этапа", async () => {
  const db = openState(":memory:");
  const { chat, seen } = fakeChat([{}]);
  const { cli, asks } = fakeCli({ ok: true, why: "" });
  const rows: unknown[][] = [];
  const ledger = createLedger({
    project: "bds-satellites",
    query: async (_s, p) => void rows.push(p),
  });
  const llm = createLlm(db, multi, chat, ledger, cli);
  assert.equal(await llm.ask("review", "s", "u", 100, 3), "по подписке");
  await llm.flush();
  assert.deepEqual(asks, [{ alias: "sonnet", effort: "medium" }]);
  assert.equal(seen.length, 0);
  assert.equal(llm.spent(), 0);
  assert.deepEqual(rows[0].slice(1, 4), ["review", "claude-sonnet-5-5", "claude-cli"]);
  const row = db.prepare("SELECT model, cost_usd FROM llm_calls").get() as { model: string };
  assert.equal(row.model, "claude-cli:claude-sonnet-5-5");
});

test("откат: подписка занята — OpenRouter; первая не ответила — следующая", async () => {
  const db = openState(":memory:");
  const { cli, asks } = fakeCli({ ok: false, why: "окно 5 ч занято на 41 %, порог 30 %" });
  // null — первая модель OpenRouter «не ответила после повторов», вторая отвечает
  const results: (Partial<ChatResult> | null)[] = [null, {}];
  const seen: string[] = [];
  const chat = {
    complete: async () => null,
    completeDetailed: async (req: ChatRequest) => {
      seen.push(req.model);
      const r = results.shift();
      return r
        ? {
            text: "ok",
            model: req.model,
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 2, reasoningTokens: 0, costUsd: 0.03 },
            ...r,
          }
        : null;
    },
  } satisfies ChatClient;
  const llm = createLlm(db, multi, chat, undefined, cli);
  assert.equal(await llm.ask("review", "s", "u", 100), "ok");
  assert.equal(asks.length, 0);
  assert.deepEqual(seen, ["m-sonnet", "m-backup"]);
});

test("откат: сбой claude-cli — дальше; все упали — последняя ошибка; без бэкенда — откат", async () => {
  const db = openState(":memory:");
  const { cli } = fakeCli({ ok: true, why: "" }, true);
  const llm = createLlm(db, multi, fakeChat([{ text: "запасная" }]).chat, undefined, cli);
  assert.equal(await llm.ask("review", "s", "u", 100), "запасная");
  await assert.rejects(llm.ask("review", "s", "u", 100), /не ответила после повторов/);
  const noCli = createLlm(db, multi, fakeChat([{ text: "без cli" }]).chat);
  assert.equal(await noCli.ask("review", "s", "u", 100), "без cli");
});

/** Чат: по коду на вызов — ошибка ChatHttpError, null — ответ «ok». */
function httpChat(steps: (number | null)[]) {
  const seen: string[] = [];
  const chat = {
    complete: async () => null,
    completeDetailed: async (req: ChatRequest) => {
      seen.push(req.model);
      const code = steps.shift();
      if (code) throw new ChatHttpError(code, `error ${code}`);
      return {
        text: "ok",
        model: req.model,
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 2, reasoningTokens: 0, costUsd: 0.01 },
      };
    },
  } satisfies ChatClient;
  return { chat, seen };
}

test("402 OpenRouter: потолок с причиной, OpenRouter больше не зовётся, запасные модели тоже", async () => {
  const db = openState(":memory:");
  const { chat, seen } = httpChat([402]);
  const llm = createLlm(db, multi, chat, undefined, fakeCli({ ok: false, why: "занято" }).cli);
  assert.equal(llm.exhausted(), false);
  assert.equal(llm.ceiling(), null);
  await assert.rejects(
    llm.ask("review", "s", "u", 100),
    (e: Error) =>
      e instanceof BudgetExceeded &&
      /OpenRouter: нет кредитов \(HTTP 402: error 402\)/.test(e.message),
  );
  assert.deepEqual(seen, ["m-sonnet"], "m-backup — тоже OpenRouter, не вызывается");
  assert.equal(llm.exhausted(), true);
  assert.match(llm.ceiling() ?? "", /нет кредитов/);
  await assert.rejects(llm.ask("write", "s", "u", 100), BudgetExceeded);
  assert.equal(seen.length, 1);
  const calls = db.prepare("SELECT count(*) AS n FROM llm_calls").get() as { n: number };
  assert.equal(calls.n, 0);
});

test("402 OpenRouter: подписка claude-cli после него работает", async () => {
  const db = openState(":memory:");
  const { chat, seen } = httpChat([402]);
  const { cli, asks } = fakeCli({ ok: true, why: "" });
  const llm = createLlm(db, multi, chat, undefined, cli);
  await assert.rejects(llm.ask("write", "s", "u", 100), BudgetExceeded);
  assert.equal(await llm.ask("review", "s", "u", 100), "по подписке");
  assert.equal(asks.length, 1);
  assert.deepEqual(seen, ["m-sonnet"]);
});

test("401/403 — не баланс: обычный откат на следующую модель", async () => {
  const db = openState(":memory:");
  const { chat, seen } = httpChat([401, null]);
  const llm = createLlm(db, multi, chat, undefined, fakeCli({ ok: false, why: "занято" }).cli);
  assert.equal(await llm.ask("review", "s", "u", 100), "ok");
  assert.deepEqual(seen, ["m-sonnet", "m-backup"]);
  assert.equal(llm.exhausted(), false);
});

test("откат: обрезанный ответ не откатывается", async () => {
  const db = openState(":memory:");
  const { chat, seen } = fakeChat([{ finishReason: "length" }, {}]);
  const llm = createLlm(db, multi, chat, undefined, fakeCli({ ok: false, why: "занято" }).cli);
  await assert.rejects(llm.ask("review", "s", "u", 100), Truncated);
  assert.equal(seen.length, 1);
});

test("A/B: тема держит вариант, темы делятся поровну, общие этапы мимо", async () => {
  const ab = parseSiteConfig(
    `site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
select: {keywords: [kafka]}
llm:
  models: {plan: base, write: base, review: rev}
  maxCostPerRunUsd: 5
  ab: {variants: {a: [m-a], b: [m-b, m-b2]}}
`,
  );
  assert.deepEqual(ab.llm.ab?.stages, ["plan", "write", "fix"]);
  const db = openState(":memory:");
  for (const id of [1, 2, 3])
    db.prepare(
      "INSERT INTO candidates (id, url_hash, url, source_id, kind, title, fetched_at) VALUES (?, ?, 'u', 's', 'news', 't', 'x')",
    ).run(id, `h${id}`);
  const { chat, seen } = fakeChat([{}, {}, {}, {}, {}, {}]);
  const llm = createLlm(db, ab, chat);
  await llm.ask("plan", "s", "u", 100, 1);
  await llm.ask("plan", "s", "u", 100, 2);
  await llm.ask("write", "s", "u", 100, 1);
  await llm.ask("plan", "s", "u", 100, 3);
  await llm.ask("review", "s", "u", 100, 1);
  await llm.ask("plan", "s", "u", 100); // без темы — базовая модель
  assert.deepEqual(
    seen.map((r) => r.model),
    ["m-a", "m-b", "m-a", "m-a", "rev", "base"],
  );
  const v = db
    .prepare("SELECT variant FROM llm_calls ORDER BY id")
    .all()
    .map((r) => (r as { variant: string | null }).variant);
  assert.deepEqual(v, ["a", "b", "a", "a", null, null]);
});

test("A/B: конфиг с одним вариантом или чужим этапом — ошибка", () => {
  const head = `site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
select: {keywords: [kafka]}
llm:
  models: {write: m}
`;
  assert.throws(() => parseSiteConfig(head + "  ab: {variants: {a: [x]}}\n"), /два варианта/);
  assert.throws(
    () => parseSiteConfig(head + "  ab: {stages: [review], variants: {a: [x], b: [y]}}\n"),
    /llm.ab.stages: review/,
  );
});
