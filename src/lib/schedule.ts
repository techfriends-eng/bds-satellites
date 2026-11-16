/**
 * Неделя сайта (ADR 0002 §3): начинается в 00:00 МСК дня `schedule.day`. С начала недели считаются
 * потолок расхода и выбор новых тем: темы выбираются один раз в неделю, первым тактом с дня сайта.
 * Москва без перехода на летнее время с 2014 года, сдвиг UTC+3 постоянный.
 */
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MSK = 3 * 3600_000;

/** Начало текущей недели сайта, ISO UTC без миллисекунд (как `at` в llm_calls). */
export function weekStart(day: string, now: Date = new Date()): string {
  const d = DAYS.indexOf(day as (typeof DAYS)[number]);
  if (d < 0) throw new Error(`schedule.day: ${day}, нужен один из ${DAYS.join(", ")}`);
  const msk = new Date(now.getTime() + MSK);
  const back = (msk.getUTCDay() - d + 7) % 7;
  const start = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - back) - MSK;
  return new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z");
}
