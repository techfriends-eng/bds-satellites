import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Локальное состояние сайта: пул кандидатов, черновики, расход LLM, индекс ссылок bigdataschool.ru.
 * SQLite (node:sqlite), а не Postgres: progon включается по требованию, а пул нужен только конвейеру
 * своего сайта. Журнал для хаба — отдельно, база sat на auto08 (src/lib/journal).
 * Схема только добавляется: новая колонка — новая запись в MIGRATIONS (handbook standards/07).
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE candidates (
     id INTEGER PRIMARY KEY,
     url_hash TEXT NOT NULL UNIQUE,      -- sha1 ключа dedupUrl
     url TEXT NOT NULL,
     source_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     published TEXT,
     fetched_at TEXT NOT NULL,
     simhash INTEGER,                    -- NULL: текст короткий, сравнение только по URL
     dup_of INTEGER REFERENCES candidates(id),
     bds_post TEXT,
     skip_reason TEXT,                   -- age | topic | prerelease
     score_relevance INTEGER,
     score_depth INTEGER,
     score_reason TEXT,
     scored_at TEXT,
     status TEXT NOT NULL DEFAULT 'new'  -- new dup bds radar skip picked rejected drafted ran run_failed gate_failed ready
   );
   CREATE INDEX candidates_status ON candidates(status);
   CREATE TABLE feed_runs (
     id INTEGER PRIMARY KEY, at TEXT NOT NULL, source_id TEXT NOT NULL,
     total INTEGER NOT NULL, new INTEGER NOT NULL, dups INTEGER NOT NULL, error TEXT
   );
   CREATE TABLE bds_posts (link TEXT PRIMARY KEY, modified TEXT NOT NULL);
   CREATE TABLE bds_links (url_hash TEXT NOT NULL, post_link TEXT NOT NULL, PRIMARY KEY (url_hash, post_link));
   CREATE TABLE llm_calls (
     id INTEGER PRIMARY KEY, at TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL, candidate_id INTEGER,
     prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER, cost_usd REAL NOT NULL DEFAULT 0
   );
   CREATE TABLE drafts (
     id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
     dir TEXT NOT NULL,                  -- каталог черновика: article.html, meta.json, run.json, gates.json, research.json
     created TEXT NOT NULL,
     wp_post_id INTEGER, wp_url TEXT, wp_status TEXT
   );`,
];

export type Db = DatabaseSync;

/**
 * Колонки кандидата для чтения. Без simhash: 64-битное значение node:sqlite не отдаёт как number
 * («Value is too large»), а SELECT * с ним падает. simhash читает только сбор, через setReadBigInts.
 */
export const CANDIDATE_COLS =
  "id, url_hash, url, source_id, kind, title, summary, published, fetched_at, dup_of, bds_post, " +
  "skip_reason, score_relevance, score_depth, score_reason, scored_at, status";

export function openState(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, at TEXT)",
  );
  const done = new Set(
    (db.prepare("SELECT n FROM _migrations").all() as { n: number }[]).map((r) => r.n),
  );
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (n, at) VALUES (?, ?)").run(
        i + 1,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
  return db;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
