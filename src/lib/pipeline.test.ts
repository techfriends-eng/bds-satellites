import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceeded } from "./llm/client.ts";
import { RUN_STEPS, runSteps, type Step } from "./pipeline.ts";

async function play(failAt: Step, err: Error): Promise<{ done: Step[]; error: string | null }> {
  const done: Step[] = [];
  const log = console.error;
  console.error = () => {};
  const error = await runSteps(
    RUN_STEPS,
    async (step) => {
      done.push(step);
      if (step === failAt) throw err;
    },
    "run",
  );
  console.error = log;
  process.exitCode = 0;
  return { done, error };
}

test("прогон начинает с visuals: ждущие обложки платят раньше новых статей", () => {
  assert.equal(RUN_STEPS[0], "visuals");
  assert.equal(RUN_STEPS.at(-1), "publish");
});

test("потолок: платные шаги стоят, схемы и публикация идут", async () => {
  const { done, error } = await play("gates", new BudgetExceeded("потолок"));
  assert.deepEqual(done, [
    "visuals",
    "collect",
    "select",
    "draft",
    "stand",
    "gates",
    "visuals",
    "publish",
  ]);
  assert.equal(error, "потолок");
});

test("другая ошибка останавливает прогон", async () => {
  const { done, error } = await play("gates", new Error("сбой"));
  assert.equal(done.at(-1), "gates");
  assert.equal(error, "сбой");
});
