import assert from "node:assert/strict";
import { test } from "node:test";
import { weekStart } from "./schedule.ts";

test("weekStart: день сайта с 00:00 МСК", () => {
  // Ср 18.11 02:00 МСК = Вт 17.11 23:00 UTC: неделя spark началась в Ср 00:00 МСК.
  assert.equal(weekStart("wed", new Date("2026-11-17T23:00:00Z")), "2026-11-17T21:00:00Z");
  // Вт 17.11 23:59 МСК: ещё прошлая неделя.
  assert.equal(weekStart("wed", new Date("2026-11-17T20:59:00Z")), "2026-11-10T21:00:00Z");
  // Вс 22.11 12:00 МСК, день сайта — вс.
  assert.equal(weekStart("sun", new Date("2026-11-22T09:00:00Z")), "2026-11-21T21:00:00Z");
});

test("weekStart: неизвестный день — ошибка", () => {
  assert.throws(() => weekStart("wednesday"), /schedule\.day/);
});
