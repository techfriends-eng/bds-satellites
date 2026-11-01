import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import type { Llm, Stage } from "../llm/client.ts";
import { openState } from "../store/db.ts";
import { loadStyle } from "../style/rules.ts";
import { images, links, uniqueness } from "./checks.ts";
import { finish, gate, reviseOnce, type GateDeps } from "./run.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const cfg = parseSiteConfig(
  "site: {id: kafka, domain: kafka-school.ru}\nselect: {keywords: [kafka]}\nstand: {images: [apache/kafka:4.3.2]}\n",
);
const pre = (lang: string, body: string) =>
  `<pre class="EnlighterJSRAW" data-enlighter-language="${lang}">${body}</pre>`;

test("образы: тег не из кэша и latest — провал, свой репозиторий без кэша — ок", () => {
  const files = new Map([
    [
      "compose.yaml",
      "# compose.yaml\nservices:\n  k:\n    image: apache/kafka:4.0.0\n  p:\n    image: postgres:16.4\n  r:\n    image: redis:latest\n",
    ],
  ]);
  const r = images(files, cfg);
  assert.equal(r.ok, false);
  assert.match(r.detail, /apache\/kafka:4\.0\.0 вместо apache\/kafka:4\.3\.2/);
  assert.match(r.detail, /redis:latest без точного тега/);
  assert.ok(!r.detail.includes("postgres"));
});

test("ссылки: исходник обязателен, мёртвая внешняя — провал, свои не проверяются", async () => {
  const html =
    '<a href="https://src/a">о</a><a href="https://dead/x">д</a><a href="https://kafka-school.ru/courses/x/">к</a>';
  const seen: string[] = [];
  const r = await links(html, "https://src/a", "kafka-school.ru", async (u) => {
    seen.push(u);
    return u.includes("dead") ? 404 : 200;
  });
  assert.equal(r.ok, false);
  assert.equal(r.detail, "https://dead/x → 404");
  assert.deepEqual(seen, ["https://src/a", "https://dead/x"]);
});

test("уникальность: копия исходника — провал, другой текст — ок", () => {
  const text = "раз два три четыре пять шесть семь восемь девять десять";
  assert.equal(uniqueness(`<p>${text}</p>`, { src: text }, 0.15).ok, false);
  assert.equal(
    uniqueness(`<p>${text}</p>`, { src: "совсем другой текст про spark без общих слов" }, 0.15).ok,
    true,
  );
});

function setup(html: string) {
  const base = mkdtempSync(join(tmpdir(), "sat-"));
  const dir = join(base, "s1");
  mkdirSync(join(dir, ".work"), { recursive: true });
  writeFileSync(join(dir, "s1.html"), html);
  writeFileSync(join(dir, "s1_meta.md"), "# m\n");
  writeFileSync(
    join(dir, ".work", "research.json"),
    JSON.stringify({ source: "", docs: "док", plan: { key: "KRaft" } }),
  );
  const db = openState(":memory:");
  db.prepare(
    "INSERT INTO candidates (id, url_hash, url, source_id, kind, title, fetched_at, status) VALUES (5, 'h', 'https://src/a', 's', 'blog', 't', 'x', 'ran')",
  ).run();
  db.prepare("INSERT INTO drafts (candidate_id, dir, created) VALUES (5, ?, 'x')").run(dir);
  return { db, dir };
}

function deps(db: ReturnType<typeof openState>, answers: Partial<Record<Stage, string>>): GateDeps {
  const llm: Llm = { spent: () => 0, ask: async (stage) => answers[stage] ?? "" };
  return {
    db,
    cfg,
    llm,
    style: loadStyle(join(ROOT, "style")),
    promptDirs: [join(ROOT, "prompts")],
    lintPy: join(ROOT, "lint", "sat_lint.py"),
    head: async () => 200,
  };
}

test("проверки: линтер оформления и смысловая проверка дают провал, отчёт в .work, статус gate_failed", async () => {
  const html = `<p>KRaft — лид: <code>x</code> <a href="https://src/a">исходник</a></p>\n${pre("bash", "# run.sh\necho")}\n<!-- output run.sh -->\n${pre("generic", "ok")}`;
  const { db, dir } = setup(html);
  const rep = await gate(
    deps(db, { review: '{"issues": [{"quote": "q", "problem": "p"}]}' }),
    { candidate_id: 5, dir },
    "s1",
  );
  assert.equal(rep.ok, false);
  assert.equal(rep.checks.lint.ok, false);
  assert.match(rep.checks.lint.detail, /Тег code/);
  assert.equal(rep.checks.code_ran.ok, true);
  assert.equal(rep.review[0].severity, "high", "без оценки — high");
  assert.ok(readFileSync(join(dir, ".work", "gates.json"), "utf8").includes('"lint"'));
  const st = db.prepare("SELECT status FROM candidates WHERE id = 5").get() as { status: string };
  assert.equal(st.status, "gate_failed");
});

test("правка: вывод возвращается настоящий, смена кода распознаётся", async () => {
  const html = `<p>a</p>\n${pre("bash", "# run.sh\necho real")}\n<!-- output run.sh -->\n${pre("generic", "настоящий вывод")}`;
  const { db, dir } = setup(html);
  writeFileSync(
    join(dir, ".work", "gates.json"),
    JSON.stringify({ ok: false, checks: {}, review: [] }),
  );
  const fake = `=====ARTICLE=====\n<p>b</p>\n${pre("bash", "# run.sh\necho real")}\n<!-- output run.sh -->\n${pre("generic", "выдуманный")}\n=====META=====\n# m2`;
  const changed = await reviseOnce(deps(db, { revise: fake }), { candidate_id: 5, dir }, "s1");
  assert.equal(changed, false);
  const out = readFileSync(join(dir, "s1.html"), "utf8");
  assert.ok(out.includes("настоящий вывод") && !out.includes("выдуманный"));
  assert.ok(out.startsWith("<p>b</p>"));
  const code = fake.replace("echo real", "echo new");
  assert.equal(await reviseOnce(deps(db, { revise: code }), { candidate_id: 5, dir }, "s1"), true);
});

test("доводка: стенд с прошлого раза не прошёл — прогон заново до правки; потолок правок за все прогоны", async () => {
  const html = `<p>KRaft — лид <a href="https://src/a">исходник</a></p>\n${pre("bash", "# run.sh\necho fixed")}\n${pre("generic", "[[output run.sh]]")}`;
  const { db, dir } = setup(html);
  writeFileSync(
    join(dir, ".work", "run.json"),
    JSON.stringify({ ok: false, log: [], results: {} }),
  );
  const stages: string[] = [];
  const d = deps(db, {});
  d.cfg = parseSiteConfig(
    `site: {id: kafka, domain: kafka-school.ru}\nselect: {keywords: [kafka]}\nstand: {base: ${join(dir, "runs")}}\n`,
  );
  d.llm = {
    spent: () => 0,
    ask: async (stage) => (
      stages.push(stage),
      stage === "review" ? '{"issues": [{"severity": "high", "quote": "q", "problem": "p"}]}' : ""
    ),
  };
  const add = db.prepare(
    "INSERT INTO llm_calls (at, stage, model, candidate_id, cost_usd) VALUES ('x', 'revise', 'm', 5, 0)",
  );
  for (let i = 0; i < cfg.gates.maxRevisionsTotal; i++) add.run();
  assert.equal(await finish(d, { candidate_id: 5, dir }, "s1"), false);
  const run = JSON.parse(readFileSync(join(dir, ".work", "run.json"), "utf8"));
  assert.equal(run.ok, true, "стенд прогнан заново");
  assert.ok(readFileSync(join(dir, "s1.html"), "utf8").includes("fixed"));
  assert.ok(!stages.includes("revise"), "потолок правок исчерпан — переписывания нет");
});
