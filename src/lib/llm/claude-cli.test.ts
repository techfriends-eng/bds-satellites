import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLI_DEFAULTS,
  createClaudeCli,
  parseStream,
  subscriptionAllows,
  type CliRun,
  type Limits,
} from "./claude-cli.ts";

const NOW = 1_794_800_000;
const H = 3600;

/** Вывод `claude -p --output-format stream-json --verbose`, как его дал CLI 2.1.326 (17.11). */
function stream(o: {
  five?: number;
  week?: number;
  weekLeftH?: number;
  text?: string;
  stop?: string;
}) {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: {} },
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: o.five ?? 0.1, resetsAt: NOW + 2 * H, status: "allowed" },
          seven_day: {
            utilization: o.week ?? 0.1,
            resetsAt: NOW + (o.weekLeftH ?? 100) * H,
            status: "allowed",
          },
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: o.text ?? "ответ",
      stop_reason: o.stop ?? "end_turn",
      total_cost_usd: 0.09,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 600,
        cache_read_input_tokens: 0,
        output_tokens: 4,
      },
      modelUsage: { "claude-sonnet-5-5": {} },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("parseStream: текст, модель, токены, лимиты; max_tokens — обрезан; ошибка — исключение", () => {
  const r = parseStream(stream({ five: 0.41, week: 0.18 }), "sonnet", NOW);
  assert.equal(r.text, "ответ");
  assert.equal(r.model, "claude-sonnet-5-5");
  assert.equal(r.usage.promptTokens, 602);
  assert.equal(r.usage.completionTokens, 4);
  assert.equal(r.usage.costUsd, 0);
  assert.equal(r.truncated, false);
  assert.equal(r.limits?.fiveHour?.utilization, 0.41);
  assert.equal(r.limits?.sevenDay?.utilization, 0.18);
  assert.equal(parseStream(stream({ stop: "max_tokens" }), "sonnet", NOW).truncated, true);
  const err = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "лимит",
  });
  assert.throws(() => parseStream(err, "sonnet", NOW), /лимит/);
  assert.throws(() => parseStream("мусор\n", "sonnet", NOW), /нет result/);
});

function limits(five: number, week: number, weekLeftH: number, status = "allowed"): Limits {
  return {
    status,
    fiveHour: { utilization: five, resetsAt: NOW + H },
    sevenDay: { utilization: week, resetsAt: NOW + weekLeftH * H },
    at: NOW,
  };
}

test("подписка: порог 5 ч, темп недели, последние сутки — порог выше", () => {
  const o = CLI_DEFAULTS;
  assert.equal(subscriptionAllows(undefined, NOW, o).ok, false);
  assert.equal(subscriptionAllows(limits(0.1, 0.1, 100, "rejected"), NOW, o).ok, false);
  assert.equal(subscriptionAllows(limits(0.29, 0.1, 100), NOW, o).ok, true);
  assert.match(subscriptionAllows(limits(0.41, 0.1, 100), NOW, o).why, /41 %, порог 30 %/);
  // Прошло 68 ч из 168 — темп ≈ 40 %: неделя 50 % его опережает
  assert.match(subscriptionAllows(limits(0.1, 0.5, 100), NOW, o).why, /темп 40 %/);
  assert.equal(subscriptionAllows(limits(0.1, 0.35, 100), NOW, o).ok, true);
  // Последние сутки: порог 5 ч 60 %, темп недели не проверяется
  assert.equal(subscriptionAllows(limits(0.5, 0.99, 20), NOW, o).ok, true);
  assert.equal(subscriptionAllows(limits(0.65, 0.5, 20), NOW, o).ok, false);
});

test("claude-cli: проба при пустых сведениях, лимиты в файл, вызов изолирован", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sat-cli-test-"));
  const file = join(dir, "claude-limits.json");
  const calls: { args: string[]; input: string; cwd: string }[] = [];
  const run: CliRun = async (args, input, { cwd }) => {
    calls.push({ args, input, cwd });
    return { code: 0, stdout: stream({ five: 0.1, week: 0.1 }), stderr: "" };
  };
  let now = NOW;
  const cli = createClaudeCli(CLI_DEFAULTS, file, {}, run, () => now);
  assert.deepEqual(await cli.allowed(), { ok: true, why: "" });
  assert.equal(calls.length, 1, "проба");
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "haiku");
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as Limits).fiveHour?.utilization, 0.1);
  // Свежие сведения — без пробы
  await cli.allowed();
  assert.equal(calls.length, 1);
  const r = await cli.ask("sonnet", "система", "вопрос", "medium");
  assert.equal(r.text, "ответ");
  const a = calls[1].args;
  for (const flag of ["--tools", "--setting-sources"]) assert.equal(a[a.indexOf(flag) + 1], "");
  assert.ok(a.includes("--no-session-persistence"));
  assert.equal(a[a.indexOf("--effort") + 1], "medium");
  assert.equal(calls[1].input, "вопрос");
  // Новый процесс читает файл: проба не нужна, пока сведения моложе 15 мин
  now += 10 * 60;
  const again = createClaudeCli(CLI_DEFAULTS, file, {}, run, () => now);
  await again.allowed();
  assert.equal(calls.length, 2);
  now += 10 * 60;
  await again.allowed();
  assert.equal(calls.length, 3, "устарело — проба");
});

test("claude-cli: проба упала — отказ с причиной, а не исключение", async () => {
  const run: CliRun = async () => ({ code: 1, stdout: "", stderr: "Invalid API key\n" });
  const cli = createClaudeCli(CLI_DEFAULTS, null, {}, run, () => NOW);
  const res = await cli.allowed();
  assert.equal(res.ok, false);
  assert.match(res.why, /проба подписки не удалась: .*нет result; код 1; stderr: Invalid API key/);
});
