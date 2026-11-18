/**
 * Время выхода статьи спутника (ToDo 98, запрос автора 03.11): будни, 8:00–14:00 МСК, случайное
 * время, статьи сайта равномерно по неделе, без совпадений с другими спутниками.
 *
 * Совпадений нет без общей базы: у каждого сайта своя полоса минут внутри часа (`publish.lane`):
 * 0 — минуты 00–14, 1 — 20–34, 2 — 40–54. Два сайта никогда не выходят ближе 6 минут друг к другу.
 * День — первый рабочий день, отстоящий от занятых дней сайта (publish и future любого автора в WP)
 * минимум на MIN_GAP_DAYS; такого нет в горизонте — самый далёкий от занятых. Статьи ложатся через
 * 2–3 дня, а не в конец горизонта.
 * Москва без перехода на летнее время, сдвиг UTC+3 постоянный (как schedule.ts).
 */
const MSK_H = 3;
const DAY_MS = 86400_000;
/** Окно выхода по Москве: начало первого часа и конец последнего (не включая). */
const FROM_H = 8;
const TO_H = 14;
const LANE_MIN = 20;
const LANE_WIDTH = 15;
export const LANES = 3;
/** Сколько дней вперёд рассматривать. */
const HORIZON_DAYS = 14;
/** Минимальный разрыв между статьями сайта, дней. */
const MIN_GAP_DAYS = 2;
/** Раньше этого запись не ставится: WordPress должен принять её как future. */
const MIN_LEAD_MS = 30 * 60_000;

/** Номер дня по Москве. */
function mskDay(ms: number): number {
  return Math.floor((ms + MSK_H * 3600_000) / DAY_MS);
}

/** `date_gmt` WordPress: `YYYY-MM-DDTHH:MM:SS` в UTC. */
function gmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * `busy` — `date_gmt` занятых записей сайта. Возвращает `date_gmt` выхода. `rand` — для тестов.
 */
export function pickSlot(
  busy: string[],
  lane: number,
  now: Date = new Date(),
  rand: () => number = Math.random,
): string {
  if (!Number.isInteger(lane) || lane < 0 || lane >= LANES)
    throw new Error(`publish.lane: ${lane}, нужен 0..${LANES - 1}`);
  const busyDays = busy.map((d) => mskDay(Date.parse(`${d.slice(0, 19)}Z`)));
  const today = mskDay(now.getTime());
  let best: { day: number; gap: number } | null = null;
  for (let day = today; day <= today + HORIZON_DAYS; day++) {
    const dow = (day + 4) % 7; // 1970-01-01 — четверг
    if (dow === 0 || dow === 6) continue;
    // Последняя минута полосы в этот день должна быть позже «сейчас + запас».
    const lastMs =
      (day * 24 + TO_H - 1 - MSK_H) * 3600_000 + (lane * LANE_MIN + LANE_WIDTH - 1) * 60_000;
    if (lastMs < now.getTime() + MIN_LEAD_MS) continue;
    const gap = busyDays.length ? Math.min(...busyDays.map((b) => Math.abs(b - day))) : Infinity;
    if (gap >= MIN_GAP_DAYS) {
      best = { day, gap };
      break;
    }
    if (!best || gap > best.gap) best = { day, gap };
  }
  if (!best) throw new Error("pickSlot: нет рабочего дня в горизонте");
  for (;;) {
    const hour = FROM_H + Math.floor(rand() * (TO_H - FROM_H));
    const minute = lane * LANE_MIN + Math.floor(rand() * LANE_WIDTH);
    const ms = (best.day * 24 + hour - MSK_H) * 3600_000 + minute * 60_000;
    if (ms >= now.getTime() + MIN_LEAD_MS) return gmt(ms);
  }
}
