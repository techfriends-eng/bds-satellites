import assert from "node:assert/strict";
import { test } from "node:test";
import { openState } from "../store/db.ts";
import { adopt, adoptedPost } from "./adopt.ts";

test("adopt: новый кандидат picked, привязан к посту; второй раз тот же пост нельзя", () => {
  const db = openState(":memory:");
  const res = adopt(db, { wpPostId: 9183, url: "https://dev.to/x/debezium", title: "Debezium" });
  assert.equal(res.created, true);
  const row = db
    .prepare("SELECT status, source_id, title FROM candidates WHERE id = ?")
    .get(res.candidateId) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: "picked", source_id: "adopt", title: "Debezium" });
  assert.equal(adoptedPost(db, res.candidateId), 9183);
  assert.throws(
    () => adopt(db, { wpPostId: 9183, url: "https://dev.to/y", title: "y" }),
    /уже привязан/,
  );
});

test("adopt: исходник уже в пуле — тот же кандидат; уже дал другой пост — отказ", () => {
  const db = openState(":memory:");
  const a = adopt(db, { wpPostId: 1, url: "https://dev.to/a", title: "a" });
  db.prepare("UPDATE candidates SET status = 'skip' WHERE id = ?").run(a.candidateId);
  db.prepare("DELETE FROM adopted").run();
  const again = adopt(db, { wpPostId: 1, url: "https://dev.to/a/", title: "a" });
  assert.deepEqual(again, { candidateId: a.candidateId, created: false });
  db.prepare("DELETE FROM adopted").run();
  db.prepare(
    "INSERT INTO drafts (candidate_id, dir, created, wp_post_id) VALUES (?, '/d', 'x', 7)",
  ).run(a.candidateId);
  assert.throws(
    () => adopt(db, { wpPostId: 9, url: "https://dev.to/a", title: "a" }),
    /уже дал пост 7/,
  );
});

test("без adopt пост не привязан", () => {
  assert.equal(adoptedPost(openState(":memory:"), 42), null);
});
