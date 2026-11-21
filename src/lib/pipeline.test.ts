import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceeded } from "./llm/client.ts";
import { parseSiteConfig } from "./config/site.ts";
import {
  acceptLive,
  syncLive,
  sweepExhausted,
  trashRejected,
  dropExhausted,
  imageModels,
  RUN_STEPS,
  runSteps,
  tickSteps,
  type Step,
} from "./pipeline.ts";
import { openState } from "./store/db.ts";

async function play(failAt: Step, err: Error): Promise<{ done: Step[]; error: string | null }> {
  const done: Step[] = [];
  const log = console.error;
  console.error = () => {};
  const error = await runSteps(
    RUN_STEPS,
    async (step) => {
      done.push(step);
      if (step === failAt) throw err;
    },
    "run",
  );
  console.error = log;
  process.exitCode = 0;
  return { done, error };
}

test("прогон начинает с visuals: ждущие обложки платят раньше новых статей", () => {
  assert.equal(RUN_STEPS[0], "visuals");
  assert.equal(RUN_STEPS.at(-1), "publish");
});

test("потолок: платные шаги стоят, схемы и публикация идут", async () => {
  const { done, error } = await play("gates", new BudgetExceeded("потолок"));
  assert.deepEqual(done, [
    "visuals",
    "collect",
    "select",
    "draft",
    "stand",
    "align",
    "gates",
    "visuals",
    "publish",
  ]);
  assert.equal(error, "потолок");
});

test("другая ошибка останавливает прогон", async () => {
  const { done, error } = await play("gates", new Error("сбой"));
  assert.equal(done.at(-1), "gates");
  assert.equal(error, "сбой");
});

test("превью: откат — вторая модель пары, без повтора основной", () => {
  assert.deepEqual(imageModels(["google/gemini-2.5-flash-image"]), [
    "google/gemini-2.5-flash-image",
    "google/gemini-3-pro-image-preview",
  ]);
  assert.deepEqual(imageModels(["google/gemini-3-pro-image-preview"]), [
    "google/gemini-3-pro-image-preview",
    "google/gemini-2.5-flash-image",
  ]);
  // Список в конфиге — как есть, без пары; префикс openrouter: снимается
  assert.deepEqual(imageModels(["openrouter:a/img", "b/img"]), ["a/img", "b/img"]);
});

test("tickSteps: новые темы только первым тактом недели", () => {
  assert.deepEqual(tickSteps(true), RUN_STEPS);
  const t = tickSteps(false);
  assert.ok(!t.includes("collect") && !t.includes("select"));
  assert.deepEqual(t, [
    "visuals",
    "draft",
    "stand",
    "align",
    "gates",
    "revise",
    "visuals",
    "publish",
  ]);
});

test("потолок правок выбран, проверки не пройдены: тема снята, взята одна замена (ADR 0004)", () => {
  const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
sources:
  - {id: aiven, kind: blog, url: "https://aiven/rss"}
select: {keywords: [kafka], perRun: 2}
gates: {maxRevisionsTotal: 2}
`);
  const db = openState(":memory:");
  const ins = db.prepare(
    `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at, status,
     score_relevance, score_depth) VALUES (?, ?, 'aiven', 'blog', 't', '', null, 'x', ?, 9, 9)`,
  );
  for (const [i, st] of ["gate_failed", "run_failed", "new", "new", "new"].entries())
    ins.run(`h${i}`, `https://x/${i}`, st);
  const revise = db.prepare(
    "INSERT INTO llm_calls (at, stage, model, candidate_id) VALUES ('x', 'revise', 'm', ?)",
  );
  const ctx = { db, cfg, ids: undefined, journal: { stats: {} as Record<string, unknown> } };
  const status = (id: number) =>
    (db.prepare("SELECT status FROM candidates WHERE id = ?").get(id) as { status: string }).status;

  revise.run(1);
  dropExhausted(ctx, 1); // одна правка из двух: ещё не снята
  assert.equal(status(1), "gate_failed");
  revise.run(1);
  revise.run(2);
  revise.run(2);
  dropExhausted(ctx, 2); // стенд не прошёл — не провал текста
  assert.equal(status(2), "run_failed");
  dropExhausted(ctx, 1);
  assert.equal(status(1), "rejected");
  const dropped = ctx.journal.stats.dropped as { id: number; replacement: number[] }[];
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].replacement.length, 1);
  assert.equal(status(dropped[0].replacement[0]), "picked");
});

test("вышедший пост — тема принята: published, конвейер её не берёт; adopt без вышедшей версии идёт дальше", () => {
  const db = openState(":memory:");
  const ins = db.prepare(
    `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at, status)
     VALUES (?, ?, 'aiven', 'blog', 't', '', null, 'x', ?)`,
  );
  const dr = db.prepare(
    "INSERT INTO drafts (candidate_id, dir, created, wp_post_id, wp_status) VALUES (?, 'd', 'x', ?, ?)",
  );
  const rows: [string, number | null, string | null][] = [
    ["gate_failed", 724, "publish"], // kafka 724: вышел, проверки не прошёл — всё равно принят
    ["ready", 9300, "publish"],
    ["ready", 9301, "future"],
    ["picked", null, null],
    ["drafted", 9185, null], // adopt: пост привязан, новая версия ещё не опубликована
    ["rejected", 9209, "publish"],
  ];
  for (const [i, [st, post, wp]] of rows.entries()) {
    ins.run(`h${i}`, `https://x/${i}`, st);
    if (st !== "picked") dr.run(i + 1, post, wp);
  }
  assert.deepEqual(acceptLive(db), [1, 2]);
  assert.deepEqual(acceptLive(db), []);
  const st = db.prepare("SELECT status FROM candidates ORDER BY id").all() as { status: string }[];
  assert.deepEqual(
    st.map((r) => r.status),
    ["published", "published", "ready", "picked", "drafted", "rejected"],
  );
});

test("статус поста берётся с сайта: вышедший по расписанию, руками или из adopt — тема принята", async () => {
  const db = openState(":memory:");
  const ins = db.prepare(
    `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at, status)
     VALUES (?, ?, 'aiven', 'blog', 't', '', null, 'x', ?)`,
  );
  const dr = db.prepare(
    "INSERT INTO drafts (candidate_id, dir, created, wp_post_id, wp_status) VALUES (?, 'd', 'x', ?, ?)",
  );
  const rows: [string, number, string | null][] = [
    ["gate_failed", 9185, null], // adopt, пост на сайте
    ["ready", 9240, "future"], // вышел по расписанию
    ["gate_failed", 9270, "draft"], // черновик, не вышел
    ["gate_failed", 9999, "draft"], // WP ответил ошибкой
  ];
  for (const [i, [st, post, wp]] of rows.entries()) {
    ins.run(`h${i}`, `https://x/${i}`, st);
    dr.run(i + 1, post, wp);
  }
  const asked: number[] = [];
  const log = console.error;
  console.error = () => {};
  const got = await syncLive(db, async (id) => {
    asked.push(id);
    if (id === 9999) throw new Error("500");
    return { status: id === 9270 ? "draft" : "publish", link: `https://k/${id}` };
  });
  console.error = log;
  assert.deepEqual(asked, [9185, 9240, 9270, 9999]);
  assert.deepEqual(got, [1, 2]);
  const st = db.prepare("SELECT status FROM candidates ORDER BY id").all() as { status: string }[];
  assert.deepEqual(
    st.map((r) => r.status),
    ["published", "published", "gate_failed", "gate_failed"],
  );
});

test("такт снимает все темы с выбранным потолком, не только правленые в этом такте", () => {
  const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
sources:
  - {id: aiven, kind: blog, url: "https://aiven/rss"}
select: {keywords: [kafka], perRun: 2}
gates: {maxRevisionsTotal: 2}
`);
  const db = openState(":memory:");
  const ins = db.prepare(
    `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at, status,
     score_relevance, score_depth) VALUES (?, ?, 'aiven', 'blog', 't', '', null, 'x', ?, 9, 9)`,
  );
  for (const [i, st] of ["gate_failed", "gate_failed", "new"].entries())
    ins.run(`h${i}`, `https://x/${i}`, st);
  db.prepare(
    "INSERT INTO drafts (candidate_id, dir, created) VALUES (1, 'a', 'x'), (2, 'b', 'x')",
  ).run();
  const revise = db.prepare(
    "INSERT INTO llm_calls (at, stage, model, candidate_id) VALUES ('x', 'revise', 'm', ?)",
  );
  for (const id of [1, 1, 1, 2]) revise.run(id); // 1 — сверх потолка (ручной rework), 2 — ещё нет
  const journal = { stats: {} as Record<string, unknown> };
  sweepExhausted({ db, cfg, ids: [], journal });
  const st = db.prepare("SELECT status FROM candidates ORDER BY id").all() as { status: string }[];
  assert.deepEqual(
    st.map((r) => r.status),
    ["rejected", "gate_failed", "picked"],
  );
});

test("снятая тема: невышедший пост в корзину WP, вышедший принят, удалённый отмечен", async () => {
  const db = openState(":memory:");
  const ins = db.prepare(
    `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at, status)
     VALUES (?, ?, 'aiven', 'blog', 't', '', null, 'x', ?)`,
  );
  const dr = db.prepare(
    "INSERT INTO drafts (candidate_id, dir, created, wp_post_id, wp_status) VALUES (?, 'd', 'x', ?, ?)",
  );
  const rows: [string, number | null, string | null][] = [
    ["rejected", 1, "draft"], // в корзину
    ["rejected", 2, "future"], // в корзину: расписание с ошибками
    ["rejected", 3, "future"], // вышел, пока висел: принят
    ["rejected", 4, "draft"], // удалён вручную
    ["rejected", 5, "deleted"], // уже отмечен: не спрашиваем
    ["rejected", null, null], // поста нет
    ["gate_failed", 7, "draft"], // тема в работе: не трогаем
  ];
  for (const [i, [st, post, wp]] of rows.entries()) {
    ins.run(`h${i}`, `https://x/${i}`, st);
    dr.run(i + 1, post, wp);
  }
  const trashed: number[] = [];
  const got = await trashRejected(db, {
    status: async (id) => {
      if (id === 4) {
        const { WpError } = await import("@techfriends-eng/toolkit/wp");
        throw new WpError("GET", 404, '{"code":"rest_post_invalid_id"}');
      }
      return { status: id === 3 ? "publish" : "draft", link: `https://k/${id}` };
    },
    trash: async (id) => {
      trashed.push(id);
    },
  });
  assert.deepEqual(trashed, [1, 2]);
  assert.deepEqual(got, [1, 2]);
  const wp = db
    .prepare(
      "SELECT c.status, d.wp_status FROM candidates c JOIN drafts d ON d.candidate_id = c.id ORDER BY c.id",
    )
    .all() as { status: string; wp_status: string | null }[];
  assert.deepEqual(
    wp.map((r) => `${r.status}/${r.wp_status}`),
    [
      "rejected/trash",
      "rejected/trash",
      "published/publish",
      "rejected/deleted",
      "rejected/deleted",
      "rejected/null",
      "gate_failed/draft",
    ],
  );
});
