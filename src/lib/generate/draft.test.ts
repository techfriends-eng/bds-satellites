import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import type { Llm, Stage } from "../llm/client.ts";
import { createFetcher, docUrlAllowed } from "../research/fetcher.ts";
import { openState } from "../store/db.ts";
import { loadStyle } from "../style/rules.ts";
import { writeDraft } from "./draft.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const cfg = parseSiteConfig(
  "site: {id: kafka, domain: kafka-school.ru}\nselect: {keywords: [kafka], maxFetches: 3}\n",
);
const LONG = `<html><body><article><p>${"Kafka KRaft контроллеры и кворум. ".repeat(80)}</p></article></body></html>`;

function fakeLlm(answers: Partial<Record<Stage, string>>) {
  const asked: { stage: Stage; system: string; user: string }[] = [];
  const llm: Llm = {
    spent: () => 0,
    exhausted: () => false,
    charge: () => {},
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
    [
      "200",
      "пусто (14 симв.); r.jina.ai: HTTP 404 https://r.jina.ai/https://b/",
      "лимит обращений",
    ],
  );
});

test("разведка: 404 и пустая страница читаются запасным читателем, сбой сайта у него не текст", async () => {
  const body = `Title: t\nMarkdown Content:\n${"Spark Structured Streaming ".repeat(40)}`;
  const pages: Record<string, string> = {
    "https://b/": "<html>Redirecting...</html>",
    "https://r.jina.ai/https://a/": body,
    "https://r.jina.ai/https://b/": body,
    "https://r.jina.ai/https://c/": "Warning: Target URL returned error 404: Not Found\nтекст",
  };
  const f = createFetcher(3, async (u) => pages[u] ?? Promise.reject(new Error(`HTTP 404 ${u}`)));
  assert.match((await f.text("https://a/", 400))!, /^Spark/);
  assert.equal((await f.text("https://b/", 400))!.length, 400);
  assert.equal(await f.text("https://c/", 1000), null);
  assert.deepEqual(
    f.log.map((e) => e.result),
    [
      "HTTP 404 https://a/; r.jina.ai: 400 симв.",
      "пусто (14 симв.); r.jina.ai: 400 симв.",
      "HTTP 404 https://c/; r.jina.ai: пусто (0 симв.)",
    ],
  );
});

test("разведка: на сайте документации из конфига читаем только его разделы", () => {
  const docs = [
    { title: "Spark", base: "https://spark.apache.org/docs/4.0.4/", pages: [] },
    { title: "Kafka", base: "https://kafka.apache.org/43/", pages: [] },
  ];
  assert.ok(docUrlAllowed(docs, "https://spark.apache.org/docs/4.0.4/configuration.html"));
  assert.ok(docUrlAllowed(docs, "https://kafka.apache.org/43/operations/kraft/#x"));
  assert.ok(docUrlAllowed(docs, "https://github.com/ollama/ollama"));
  assert.ok(!docUrlAllowed(docs, "https://spark.apache.org/docs/3.5.3/configuration.html"));
  assert.ok(!docUrlAllowed(docs, "https://kafka.apache.org/documentation/#kraft"));
  assert.ok(!docUrlAllowed(docs, "не адрес"));
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

test("черновик: угаданная версия документации не читается, в журнале причина", async () => {
  const db = seed();
  const { llm } = fakeLlm({
    plan: JSON.stringify({
      verdict: "take",
      slug: "spark_guess",
      doc_urls: [
        "https://spark.apache.org/docs/3.5.3/configuration.html",
        "https://spark.apache.org/docs/4.0.4/configuration.html",
      ],
    }),
    write: "=====ARTICLE=====\n<p>x</p>\n=====META=====\n# M\n",
  });
  const asked: string[] = [];
  const out = await writeDraft(
    {
      db,
      cfg: {
        ...cfg,
        docs: [{ title: "Spark", base: "https://spark.apache.org/docs/4.0.4/", pages: [] }],
      },
      llm,
      style: loadStyle(join(ROOT, "style")),
      promptDirs: [join(ROOT, "prompts")],
      draftsDir: mkdtempSync(join(tmpdir(), "sat-")),
      getHtml: async (u) => {
        asked.push(u);
        return LONG;
      },
    },
    db.prepare("SELECT * FROM candidates WHERE id = 13").get() as never,
  );
  assert.ok(!asked.some((u) => u.includes("3.5.3")));
  assert.ok(asked.some((u) => u.includes("4.0.4")));
  const research = JSON.parse(readFileSync(join(out!, ".work", "research.json"), "utf8"));
  assert.match(research.fetchLog, /3\.5\.3\S* — адрес вне разделов/);
  assert.match(research.docs, /4\.0\.4/);
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

test("черновик: write упал — следующий прогон берёт план из кэша, за план не платит", async () => {
  const db = seed();
  const dir = mkdtempSync(join(tmpdir(), "sat-"));
  const plan = JSON.stringify({
    verdict: "take",
    why: "ok",
    slug: "kraft_q",
    key: "K",
    title: "t",
  });
  const deps = (llm: Llm) => ({
    db,
    cfg,
    llm,
    style: loadStyle(join(ROOT, "style")),
    promptDirs: [join(ROOT, "prompts")],
    draftsDir: dir,
    getHtml: async () => LONG,
  });
  const row = () => db.prepare("SELECT * FROM candidates WHERE id = 13").get() as never;
  const failing: Llm = {
    spent: () => 0,
    exhausted: () => false,
    charge: () => {},
    ask: async (stage) => {
      if (stage === "plan") return plan;
      throw new Error("write: модель не ответила после повторов");
    },
  };
  await assert.rejects(writeDraft(deps(failing), row()), /write/);
  assert.ok(existsSync(join(dir, ".plans", "13.json")));

  const { llm, asked } = fakeLlm({ write: "=====ARTICLE=====\n<p>K</p>\n=====META=====\n# М\n" });
  assert.equal(await writeDraft(deps(llm), row()), join(dir, "kraft_q"));
  assert.deepEqual(
    asked.map((a) => a.stage),
    ["write"],
  );
  assert.ok(!existsSync(join(dir, ".plans", "13.json")));
});

test("черновик: исходник не прочитан — unreadable, причина с путём, LLM не вызывается", async () => {
  const db = seed();
  const dir = mkdtempSync(join(tmpdir(), "sat-"));
  const { llm, asked } = fakeLlm({});
  const out = await writeDraft(
    {
      db,
      cfg,
      llm,
      style: loadStyle(join(ROOT, "style")),
      promptDirs: [join(ROOT, "prompts")],
      draftsDir: dir,
      manualDir: join(dir, "source-text"),
      getHtml: async (u) => Promise.reject(new Error(`HTTP 403 ${u}`)),
    },
    db.prepare("SELECT * FROM candidates WHERE id = 13").get() as never,
  );
  assert.equal(out, null);
  assert.equal(asked.length, 0);
  const row = db.prepare("SELECT status, skip_reason FROM candidates WHERE id = 13").get() as {
    status: string;
    skip_reason: string;
  };
  assert.equal(row.status, "unreadable");
  assert.ok(row.skip_reason.includes(join(dir, "source-text", "13.md")));
});

test("черновик: план в кэше построен по анонсу — кэш не используется", async () => {
  const db = seed();
  const dir = mkdtempSync(join(tmpdir(), "sat-"));
  mkdirSync(join(dir, ".plans"));
  writeFileSync(
    join(dir, ".plans", "13.json"),
    JSON.stringify({ source: "анонс", docs: "", fetchLog: "", plan: { verdict: "take" } }),
  );
  const { llm, asked } = fakeLlm({ plan: '{"verdict": "skip", "why": "нет"}' });
  await writeDraft(
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
  assert.equal(asked[0].stage, "plan");
});
