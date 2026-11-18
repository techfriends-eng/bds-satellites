import assert from "node:assert/strict";
import { test } from "node:test";
import { pickSlot } from "./slot.ts";

// Среда 18.11.2026, 14:40 МСК.
const NOW = new Date("2026-11-18T11:40:00Z");
const msk = (gmt: string) => new Date(Date.parse(`${gmt}Z`) + 3 * 3600_000);

test("слот: будни, 8:00–14:00 МСК, минуты своей полосы", () => {
  for (let i = 0; i < 200; i++) {
    for (const lane of [0, 1, 2]) {
      const t = msk(pickSlot([], lane, NOW));
      assert.ok(t.getUTCDay() >= 1 && t.getUTCDay() <= 5);
      assert.ok(t.getUTCHours() >= 8 && t.getUTCHours() < 14);
      const m = t.getUTCMinutes();
      assert.ok(m >= lane * 20 && m < lane * 20 + 15, `lane ${lane}: ${m}`);
      assert.ok(t.getTime() - 3 * 3600_000 > NOW.getTime());
    }
  }
});

test("слот: день подальше от занятых дней сайта, выходные пропускаются", () => {
  const rand = () => 0.5;
  // Окно сегодня закрыто (после 14:00): ближайший свободный будний день — чт 19.11.
  assert.equal(pickSlot([], 1, NOW, rand).slice(0, 10), "2026-11-19");
  // Заняты 18 и 19.11: первый будний день в 2 днях от них — сб 21 нельзя, значит пн 23.11.
  const busy = ["2026-11-18T08:00:00", "2026-11-19T08:00:00", "2026-12-02T08:00:00"];
  assert.equal(pickSlot(busy, 0, NOW, rand).slice(0, 10), "2026-11-23");
  // Занят только сегодняшний день: пт 20.11, а не конец горизонта.
  assert.equal(pickSlot(["2026-11-18T08:00:00"], 0, NOW, rand).slice(0, 10), "2026-11-20");
  // Заняты все дни горизонта: первый доступный будний день.
  const all = Array.from({ length: 16 }, (_, i) =>
    new Date(Date.UTC(2026, 10, 18 + i, 8)).toISOString().slice(0, 19),
  );
  assert.equal(pickSlot(all, 0, NOW, rand).slice(0, 10), "2026-11-19");
});

test("слот: неверная полоса — ошибка", () => {
  assert.throws(() => pickSlot([], 3, NOW), /publish.lane/);
});
