import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import type { Llm, Stage } from "../llm/client.ts";
import { createFetcher } from "../research/fetcher.ts";
import { openState } from "../store/db.ts";
import { loadStyle } from "../style/rules.ts";
import { writeDraft } from "./draft.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const cfg = parseSiteConfig(
  "site: {id: kafka, domain: kafka-school.ru}\nselect: {keywords: [kafka], maxFetches: 3}\n",
);
const LONG = `<html><body><article><p>${"Kafka KRaft контроллеры и кворум. ".repeat(40)}</p></article></body></html>`;

function fakeLlm(answers: Partial<Record<Stage, string>>) {
  const asked: { stage: Stage; system: string; user: string }[] = [];
  const llm: Llm = {
    spent: () => 0,
    ask: async (stage, system, user) => {
      asked.push({ stage, system, user });
      return answers[stage] ?? "";
    },
  };
  return { llm, asked };
}

function seed() {
  const db = openState(":memory:");
  db.prepare(
    "INSERT INTO candidates (id, url_hash, url, source_id, kind, title, summary, fetched_at, status) VALUES (13, 'h', 'https://aiven.io/q', 'aiven', 'blog', 'Quorum', 'short', 'x', 'picked')",
  ).run();
  return db;
}

test("разведка: лимит обращений, пустая страница — «пусто», meta refresh разворачивается", async () => {
  const pages: Record<string, string> = {
    "https://a/": '<meta http-equiv="refresh" content="0; url=/real">',
    "https://a/real": LONG,
    "https://b/": "<html>Redirecting...</html>",
  };
  const f = createFetcher(2, async (u) => pages[u] ?? Promise.reject(new Error(`HTTP 404 ${u}`)));
  assert.ok((await f.text("https://a/", 1000))?.includes("KRaft"));
  assert.equal(await f.text("https://b/", 1000), null);
  assert.equal(await f.text("https://c/", 1000), null);
  assert.deepEqual(
    f.log.map((e) => e.result),
    ["200", "пусто (14 симв.)", "лимит обращений"],
  );
});

test("черновик: план → документация → статья и метаданные по путям B0, правила в промпте", async () => {
  const db = seed();
  const dir = mkdtempSync(join(tmpdir(), "sat-"));
  const { llm, asked } = fakeLlm({
    plan: JSON.stringify({
      verdict: "take",
      why: "ok",
      slug: "kraft_quorum_loss",
      key: "KRaft",
      title: "t",
      doc_urls: ["https://doc/1"],
    }),
    write: "=====ARTICLE=====\n<p>KRaft лид.</p>\n=====META=====\n# Метаданные\n",
  });
  const out = await writeDraft(
    {
      db,
      cfg,
      llm,
      style: loadStyle(join(ROOT, "style")),
      promptDirs: [join(ROOT, "prompts")],
      draftsDir: dir,
      getHtml: async () => LONG,
    },
    db.prepare("SELECT * FROM candidates WHERE id = 13").get() as never,
  );
  assert.equal(out, join(dir, "kraft_quorum_loss"));
  assert.equal(readFileSync(join(out!, "kraft_quorum_loss.html"), "utf8"), "<p>KRaft лид.</p>\n");
  assert.ok(existsSync(join(out!, "kraft_quorum_loss_meta.md")));
  assert.ok(existsSync(join(out!, ".work", "research.json")));
  const write = asked.find((a) => a.stage === "write")!;
  assert.match(write.system, /STYLE GUIDE V10-Blog/);
  assert.match(write.system, /Баннеров `\[cbanner\]`/);
  assert.ok(!write.system.includes("{style_guide}"));
  const st = db.prepare("SELECT status FROM candidates WHERE id = 13").get() as { status: string };
  assert.equal(st.status, "drafted");
});

test("черновик: план «не брать» — rejected с причиной, файлов нет", async () => {
  const db = seed();
  const { llm } = fakeLlm({ plan: '{"verdict": "skip", "why": "патч форка"}' });
  const dir = mkdtempSync(join(tmpdir(), "sat-"));
  const out = await writeDraft(
    {
      db,
      cfg,
      llm,
      style: loadStyle(join(ROOT, "style")),
      promptDirs: [join(ROOT, "prompts")],
      draftsDir: dir,
      getHtml: async () => LONG,
    },
    db.prepare("SELECT * FROM candidates WHERE id = 13").get() as never,
  );
  assert.equal(out, null);
  const row = db.prepare("SELECT status, score_reason FROM candidates WHERE id = 13").get() as {
    status: string;
    score_reason: string;
  };
  assert.deepEqual({ ...row }, { status: "rejected", score_reason: "план: патч форка" });
});
