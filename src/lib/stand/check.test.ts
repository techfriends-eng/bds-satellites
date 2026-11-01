import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import type { Llm } from "../llm/client.ts";
import { openState } from "../store/db.ts";
import { checkDraft } from "./check.ts";
import { commandFor, runStand, shellExec, type Exec } from "./runner.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const pre = (lang: string, body: string) =>
  `<pre class="EnlighterJSRAW" data-enlighter-language="${lang}">${body}</pre>`;

test("раннер по-настоящему: run.sh, затем файл с выводом; падение задания видно по коду", () => {
  const work = mkdtempSync(join(tmpdir(), "stand-"));
  const files = new Map([
    ["run.sh", "# run.sh\necho stand up\n"],
    ["t.py", "# t.py\nimport sys\nprint('task')\nsys.exit(3)\n"],
  ]);
  const res = runStand(join(work, "p"), "sat-test-1", files, ["t.py"], shellExec);
  assert.equal(res["run.sh"].out.trim(), "stand up");
  assert.equal(res["t.py"].rc, 3);
  assert.equal(res["t.py"].out.trim(), "task");
  assert.equal(res._down, undefined, "без compose.yaml стенд не гасится");
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), "sat-"));
  const cfg = parseSiteConfig(
    `site: {id: kafka, domain: kafka-school.ru}\nselect: {keywords: [kafka]}\nstand: {base: ${base}/runs, maxFixes: 2}\n`,
  );
  const dir = join(base, "drafts", "s1");
  mkdirSync(join(dir, ".work"), { recursive: true });
  const html = [
    "<p>Лид.</p>",
    pre("bash", "# run.sh · Kafka 4.3.2\nexit 1"),
    pre("generic", "[[output run.sh]]"),
    pre("python", "# t.py\nprint(1 &lt; 2)"),
    pre("generic", "[[output t.py]]"),
  ].join("\n");
  writeFileSync(join(dir, "s1.html"), html);
  const db = openState(":memory:");
  db.prepare(
    "INSERT INTO candidates (id, url_hash, url, source_id, kind, title, fetched_at, status) VALUES (5, 'h', 'u', 's', 'blog', 't', 'x', 'drafted')",
  ).run();
  return { cfg, db, dir };
}

test("прогон: упал → починка через LLM меняет код в статье → вывод на метки, статус ran", async () => {
  const { cfg, db, dir } = setup();
  const calls: string[] = [];
  const exec: Exec = (cmd) => {
    calls.push(cmd);
    if (cmd === "bash run.sh") {
      return calls.filter((c) => c === "bash run.sh").length === 1
        ? { rc: 1, out: "boom", seconds: 1 }
        : { rc: 0, out: "stand ok", seconds: 1 };
    }
    return { rc: 0, out: "True", seconds: 1 };
  };
  const llm: Llm = {
    spent: () => 0,
    ask: async (stage, _s, user) => {
      assert.equal(stage, "fix");
      assert.match(user, /boom/);
      return JSON.stringify({
        cause: "exit 1",
        files: { "run.sh": "# run.sh · Kafka 4.3.2\necho ok\n" },
      });
    },
  };
  const ok = await checkDraft(
    { db, cfg, llm, promptDirs: [join(ROOT, "prompts")], exec },
    { candidate_id: 5, dir },
    "s1",
  );
  assert.equal(ok, true);
  const html = readFileSync(join(dir, "s1.html"), "utf8");
  assert.ok(html.includes("# run.sh · Kafka 4.3.2\necho ok"));
  assert.ok(html.includes("<!-- output run.sh -->"));
  assert.ok(html.includes('generic">stand ok</pre>'));
  assert.ok(html.includes('generic">True</pre>'));
  const run = JSON.parse(readFileSync(join(dir, ".work", "run.json"), "utf8"));
  assert.equal(run.log[0].cause, "exit 1");
  const st = db.prepare("SELECT status FROM candidates WHERE id = 5").get() as { status: string };
  assert.equal(st.status, "ran");
});

test("прогон: починки кончились — run_failed, вывод не вставлен", async () => {
  const { cfg, db, dir } = setup();
  const exec: Exec = () => ({ rc: 1, out: "boom", seconds: 1 });
  const llm: Llm = { spent: () => 0, ask: async () => '{"cause": "?", "files": {}}' };
  const ok = await checkDraft(
    { db, cfg, llm, promptDirs: [join(ROOT, "prompts")], exec },
    { candidate_id: 5, dir },
    "s1",
  );
  assert.equal(ok, false);
  assert.ok(readFileSync(join(dir, "s1.html"), "utf8").includes("[[output run.sh]]"));
  const st = db.prepare("SELECT status FROM candidates WHERE id = 5").get() as { status: string };
  assert.equal(st.status, "run_failed");
});

test("раннер: *.py командой сайта stand.pyRun, без неё — .venv или python3", () => {
  const work = mkdtempSync(join(tmpdir(), "stand-"));
  assert.equal(
    commandFor("t.py", work, "docker compose exec -T spark spark-submit /work/{file}"),
    "docker compose exec -T spark spark-submit /work/t.py",
  );
  assert.equal(commandFor("t.py", work), "python3 t.py");
  assert.equal(commandFor("run.sh", work, "x {file}"), "bash run.sh");
});
