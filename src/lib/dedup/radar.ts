import type { Db } from "../store/db.ts";
import { urlHash } from "./keys.ts";

/**
 * Сверка с основным контуром: кандидат, который Stack Radar предложил, одобрил или опубликовал,
 * спутник не берёт. Отсеянное основным контуром (rejected, expired) брать можно.
 * Роль sat_reader видит только нужные колонки articles; pg_hba пускает её только с progon.
 */
export const TAKEN_SQL = `SELECT url FROM articles
  WHERE pick_status IN ('approved', 'offered', 'debug') OR wp_url IS NOT NULL`;

export type QueryUrls = () => Promise<string[]>;

export async function markRadar(db: Db, takenUrls: QueryUrls): Promise<number> {
  const taken = new Set((await takenUrls()).map(urlHash));
  const rows = db.prepare("SELECT id, url_hash FROM candidates WHERE status = 'new'").all() as {
    id: number;
    url_hash: string;
  }[];
  const mark = db.prepare("UPDATE candidates SET status = 'radar' WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    if (taken.has(r.url_hash)) {
      mark.run(r.id);
      n++;
    }
  }
  return n;
}
