import { urlHash } from "../dedup/keys.ts";
import { nowIso, type Db } from "../store/db.ts";

/**
 * Переделка старого поста WP по новым правилам (ToDo 97): исходник становится кандидатом `picked`,
 * а черновик после шага draft пишет в тот же пост, а не создаёт новый. Адрес поста не меняется:
 * обновление в WP не трогает slug и статус.
 */
export type Adopted = { candidateId: number; created: boolean };

export function adopt(db: Db, input: { wpPostId: number; url: string; title: string }): Adopted {
  const taken = db
    .prepare("SELECT candidate_id FROM adopted WHERE wp_post_id = ?")
    .get(input.wpPostId) as { candidate_id: number } | undefined;
  if (taken)
    throw new Error(`пост ${input.wpPostId} уже привязан к кандидату ${taken.candidate_id}`);
  const hash = urlHash(input.url);
  const existing = db
    .prepare(
      "SELECT c.id, d.wp_post_id FROM candidates c LEFT JOIN drafts d ON d.candidate_id = c.id WHERE c.url_hash = ?",
    )
    .get(hash) as { id: number; wp_post_id: number | null } | undefined;
  if (existing?.wp_post_id && existing.wp_post_id !== input.wpPostId)
    throw new Error(
      `исходник уже дал пост ${existing.wp_post_id} (кандидат ${existing.id}): второй пост по нему не привязываем`,
    );
  let candidateId: number;
  if (existing) {
    candidateId = existing.id;
    db.prepare("UPDATE candidates SET status = 'picked', dup_of = NULL WHERE id = ?").run(
      candidateId,
    );
  } else {
    const r = db
      .prepare(
        `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, fetched_at, status)
         VALUES (?, ?, 'adopt', 'article', ?, '', ?, 'picked')`,
      )
      .run(hash, input.url, input.title, nowIso());
    candidateId = Number(r.lastInsertRowid);
  }
  db.prepare("INSERT INTO adopted (candidate_id, wp_post_id, at) VALUES (?, ?, ?)").run(
    candidateId,
    input.wpPostId,
    nowIso(),
  );
  return { candidateId, created: !existing };
}

/** Пост WP, к которому привязан кандидат командой adopt; null — обычная тема. */
export function adoptedPost(db: Db, candidateId: number): number | null {
  const row = db
    .prepare("SELECT wp_post_id FROM adopted WHERE candidate_id = ?")
    .get(candidateId) as { wp_post_id: number } | undefined;
  return row?.wp_post_id ?? null;
}
