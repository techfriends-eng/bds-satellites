import type { Db } from "../store/db.ts";

/** Строка отчёта A/B: одна на вариант. */
export type AbRow = {
  variant: string;
  topics: number;
  /** Темы, дошедшие до готового черновика (ready) или до WP. */
  ready: number;
  /** Готовые без единого вызова fix: стенд прошёл с первого раза. */
  firstPass: number;
  gateFailed: number;
  runFailed: number;
  published: number;
  fixCalls: number;
  costUsd: number;
};

/**
 * Сравнение вариантов (ADR 0002 п. 2): цена на тему считается по вызовам этапов варианта
 * (plan, write, fix), review/revise/image общие и в сравнение не входят.
 */
export function abReport(db: Db): AbRow[] {
  return db
    .prepare(
      `SELECT c.variant AS variant,
         COUNT(*) AS topics,
         SUM(c.status = 'ready' OR d.wp_post_id IS NOT NULL) AS ready,
         SUM((c.status = 'ready' OR d.wp_post_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM llm_calls f WHERE f.candidate_id = c.id AND f.stage = 'fix')) AS firstPass,
         SUM(c.status = 'gate_failed') AS gateFailed,
         SUM(c.status = 'run_failed') AS runFailed,
         COALESCE(SUM(d.wp_status = 'publish'), 0) AS published,
         (SELECT COUNT(*) FROM llm_calls l JOIN candidates c2 ON c2.id = l.candidate_id
            WHERE c2.variant = c.variant AND l.stage = 'fix') AS fixCalls,
         (SELECT COALESCE(SUM(l.cost_usd), 0) FROM llm_calls l
            WHERE l.variant = c.variant) AS costUsd
       FROM candidates c LEFT JOIN drafts d ON d.candidate_id = c.id
       WHERE c.variant IS NOT NULL
       GROUP BY c.variant ORDER BY c.variant`,
    )
    .all() as AbRow[];
}

export function formatAb(rows: AbRow[]): string {
  if (!rows.length) return "A/B: тем с вариантом нет";
  const lines = rows.map((r) => {
    const per = r.topics ? (r.costUsd / r.topics).toFixed(3) : "-";
    return (
      `${r.variant}: тем ${r.topics}, готово ${r.ready} (с первого раза ${r.firstPass}), ` +
      `стенд упал ${r.runFailed}, гейты ${r.gateFailed}, в WP ${r.published}, fix ${r.fixCalls}, ` +
      `$${r.costUsd.toFixed(3)} (на тему $${per})`
    );
  });
  return lines.join("\n");
}
