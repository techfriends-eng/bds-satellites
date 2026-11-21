import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WpError, type WpClient } from "@techfriends-eng/toolkit/wp";
import { parseSiteConfig } from "../config/site.ts";
import { articleRow, createJournal } from "../journal/journal.ts";
import { openState } from "../store/db.ts";
import { gateNote, postGone, publishDraft, seoOf, trashPost, withUtm, yoastMeta } from "./wp.ts";

const cfg = parseSiteConfig(
  "site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}\nselect: {keywords: [kafka]}\npublish: {categories: [127]}\n",
);

test("UTM только на курсы своего сайта", () => {
  const html =
    '<a href="https://kafka-school.ru/courses/apache-kafka-developers/">к</a> <a href="https://kafka.apache.org/x">д</a>';
  assert.equal(
    withUtm(html, "kafka-school.ru", "s1"),
    '<a href="https://kafka-school.ru/courses/apache-kafka-developers/?utm_source=sat&amp;utm_medium=article&amp;utm_campaign=s1">к</a> <a href="https://kafka.apache.org/x">д</a>',
  );
});

test("комментарий о провале: проверки и high-замечания, без «--» внутри комментария", () => {
  const note = gateNote({
    ok: false,
    checks: { lint: { ok: false, detail: "Тег code" }, links: { ok: true, detail: "" } },
    review: [
      { severity: "high", quote: "q", problem: "текст -- против вывода" },
      { severity: "low", quote: "q", problem: "мелочь" },
    ],
  });
  assert.equal(
    note,
    "<!-- sat: проверки не пройдены, статья не для публикации как есть\n- lint: Тег code\n- текст — против вывода\n-->\n",
  );
  assert.equal(gateNote({ ok: true, checks: {}, review: [] }), "");
});

test("провал стиля: ни картинок, ни нового поста, ни обновления старого", async () => {
  const { db } = setup();
  const touched: string[] = [];
  const wp = new Proxy(
    {},
    {
      get: (_t, name) => () => {
        touched.push(String(name));
        throw new Error("WP трогать нельзя");
      },
    },
  ) as unknown as WpClient;
  db.prepare("UPDATE drafts SET wp_post_id = 9197 WHERE id = 1").run();
  const draft = db.prepare("SELECT * FROM drafts WHERE id = 1").get() as never;
  const res = await publishDraft(
    {
      db,
      cfg,
      wp,
      creds: { username: "u", appPassword: "p" },
      styleFailures: () => ["Длинное тире: 2 шт"],
    },
    draft,
    "s1",
  );
  assert.deepEqual(res, { blocked: ["Длинное тире: 2 шт"] });
  assert.deepEqual(touched, []);
});

function setup() {
  const dir = join(mkdtempSync(join(tmpdir(), "pub-")), "s1");
  mkdirSync(join(dir, ".work"), { recursive: true });
  writeFileSync(
    join(dir, "s1.html"),
    '<p>Лид <a href="https://kafka-school.ru/courses/x/">курс</a></p>\n<img class="aligncenter size-full" src="TODO_IMAGE/s1_scheme1.jpg" alt="схема" />\n',
  );
  writeFileSync(
    join(dir, "s1_meta.md"),
    "- **Заголовок статьи:** Кворум KRaft\n\n### Превью-картинка\n\n- **Имя файла:** `s1_preview.jpg`\n- **ALT:** превью\n\n    prompt\n\n### Схема 1. С\n\n- **Имя файла:** `s1_scheme1.jpg`\n- **ALT:** схема\n\n```mermaid\nflowchart LR\n```\n",
  );
  writeFileSync(join(dir, "s1_scheme1.jpg"), "jpg");
  writeFileSync(join(dir, "s1_preview.jpg"), "jpg");
  writeFileSync(
    join(dir, ".work", "gates.json"),
    JSON.stringify({ ok: true, checks: {}, review: [] }),
  );
  const db = openState(":memory:");
  db.prepare(
    "INSERT INTO candidates (id, url_hash, url, source_id, kind, title, fetched_at, status) VALUES (5, 'h', 'https://src', 'aiven', 'blog', 'orig', 'x', 'ready')",
  ).run();
  db.prepare("INSERT INTO drafts (id, candidate_id, dir, created) VALUES (1, 5, ?, 'x')").run(dir);
  db.prepare(
    "INSERT INTO llm_calls (at, stage, model, candidate_id, cost_usd) VALUES ('x', 'write', 'm', 5, 0.2345)",
  ).run();
  return { db, dir };
}

test("публикация: картинки в медиатеку, превью — обложкой, черновик, повтор обновляет тот же пост", async () => {
  const { db, dir } = setup();
  const calls: string[] = [];
  let n = 100;
  const wp = {
    uploadMedia: async (i: { filename: string }) => {
      calls.push(`media ${i.filename}`);
      return { id: ++n, sourceUrl: `https://kafka-school.ru/wp-content/${i.filename}` };
    },
    createEntry: async (i: {
      status: string;
      featuredMedia?: number;
      contentHtml: string;
      categories?: number[];
    }) => {
      calls.push(`create ${i.status} featured=${i.featuredMedia} cat=${i.categories}`);
      assert.ok(i.contentHtml.includes('src="https://kafka-school.ru/wp-content/s1_scheme1.jpg"'));
      assert.ok(i.contentHtml.includes("utm_campaign=s1"));
      return { id: 9200, link: "https://kafka-school.ru/?p=9200", slug: "s1", status: "draft" };
    },
    updateEntry: async (id: number, i: { featuredMedia?: number }) => {
      calls.push(`update ${id} featured=${i.featuredMedia}`);
      return { id, link: "https://kafka-school.ru/?p=9200", slug: "s1", status: "draft" };
    },
  } as unknown as WpClient;
  const creds = { username: "u", appPassword: "p" };
  const draft = () => db.prepare("SELECT * FROM drafts WHERE id = 1").get() as never;
  await publishDraft({ db, cfg, wp, creds, styleFailures: () => [] }, draft(), "s1");
  await publishDraft({ db, cfg, wp, creds, styleFailures: () => [] }, draft(), "s1");
  assert.deepEqual(calls, [
    "media s1_scheme1.jpg",
    "media s1_preview.jpg",
    "create draft featured=102 cat=127",
    "update 9200 featured=102",
  ]);

  const row = articleRow(db, cfg, 5);
  assert.deepEqual(row.slice(0, 6), ["kafka", 5, "Кворум KRaft", "https://src", "aiven", "ready"]);
  assert.deepEqual(row.slice(-4), [9200, "https://kafka-school.ru/?p=9200", "draft", 0.235]);
  void dir;
});

test("журнал: статьи и прогон одной серией запросов, сбой базы не роняет прогон", async () => {
  const { db } = setup();
  const j = createJournal(db, cfg, "run");
  j.touch(5);
  j.stats.picked = [5];
  const sqls: string[] = [];
  await j.close(async (sql) => void sqls.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")), 0.5);
  assert.deepEqual(sqls, ["INSERT INTO sat.articles", "INSERT INTO sat.runs"]);
  assert.deepEqual(j.stats.ledger, [{ id: 5, revisions: 0, reason: null }]);
  await j.close(async () => {
    throw new Error("ECONNREFUSED");
  }, 0);
});

const SEO_META =
  "- **Заголовок статьи:** Кворум KRaft\n\n## SEO\n\n- **Title:** Кворум KRaft без паники\n- **Description:** Что делать при потере кворума.\n- **Keywords:** KRaft, Apache Kafka, кворум\n";

test("SEO: блок разбирается, поля Yoast как у блога", () => {
  const seo = seoOf(SEO_META);
  assert.deepEqual(seo, {
    title: "Кворум KRaft без паники",
    description: "Что делать при потере кворума.",
    keywords: ["KRaft", "Apache Kafka", "кворум"],
  });
  assert.deepEqual(yoastMeta(seo, [127]), {
    _yoast_wpseo_title: "Кворум KRaft без паники",
    _yoast_wpseo_metadesc: "Что делать при потере кворума.",
    _yoast_wpseo_focuskw: "KRaft",
    _yoast_wpseo_primary_category: "127",
  });
  assert.deepEqual(seoOf("- **Заголовок статьи:** X\n").keywords, []);
});

test("публикация: метки из Keywords; seoMeta без mu-плагина — ошибка до записи, с ним — поля Yoast", async () => {
  const { db, dir } = setup();
  writeFileSync(join(dir, "s1_meta.md"), SEO_META);
  const seen: { tags?: number[]; meta?: Record<string, string> }[] = [];
  let metaKeys = ["footnotes"];
  const wp = {
    uploadMedia: async () => ({ id: 1, sourceUrl: "u" }),
    ensureTags: async (names: string[]) => names.map((_, i) => 40 + i),
    restMetaKeys: async () => metaKeys,
    createEntry: async (i: { tags?: number[]; meta?: Record<string, string> }) => {
      seen.push(i);
      return { id: 9300, link: "L", slug: "s1", status: "draft" };
    },
    updateEntry: async (id: number, i: { tags?: number[]; meta?: Record<string, string> }) => {
      seen.push(i);
      return { id, link: "L", slug: "s1", status: "draft" };
    },
  } as unknown as WpClient;
  const creds = { username: "u", appPassword: "p" };
  const draft = () => db.prepare("SELECT * FROM drafts WHERE id = 1").get() as never;
  await publishDraft({ db, cfg, wp, creds, styleFailures: () => [] }, draft(), "s1");
  assert.deepEqual(seen[0].tags, [40, 41, 42]);
  assert.equal(seen[0].meta, undefined);

  const on = { ...cfg, publish: { ...cfg.publish, seoMeta: true } };
  await assert.rejects(
    publishDraft({ db, cfg: on, wp, creds, styleFailures: () => [] }, draft(), "s1"),
    /нет mu-плагина bds-rest-seo-meta/,
  );
  assert.equal(seen.length, 1, "без плагина запись не обновлялась");
  metaKeys = [
    "_yoast_wpseo_title",
    "_yoast_wpseo_metadesc",
    "_yoast_wpseo_focuskw",
    "_yoast_wpseo_primary_category",
  ];
  await publishDraft({ db, cfg: on, wp, creds, styleFailures: () => [] }, draft(), "s1");
  assert.equal(seen[1].meta?._yoast_wpseo_focuskw, "KRaft");
  assert.equal(
    "_yoast_wpseo_primary_category" in (seen[1].meta ?? {}),
    false,
    "обновление без categories",
  );
});

test("провал проверок: в WP ничего не уходит, ни новый пост, ни обновление старого (ADR 0004)", async () => {
  for (const postId of [null, 9185]) {
    const { db, dir } = setup();
    writeFileSync(
      join(dir, ".work", "gates.json"),
      JSON.stringify({ ok: false, checks: { lint: { ok: false, detail: "x" } }, review: [] }),
    );
    db.prepare("UPDATE drafts SET wp_post_id = ? WHERE id = 1").run(postId);
    const calls: string[] = [];
    const wp = new Proxy(
      {},
      {
        get: (_t, name) => async () => {
          calls.push(String(name));
          throw new Error("WP не должен вызываться");
        },
      },
    ) as unknown as WpClient;
    const draft = db.prepare("SELECT * FROM drafts WHERE id = 1").get() as never;
    const res = await publishDraft(
      { db, cfg, wp, creds: { username: "u", appPassword: "p" }, styleFailures: () => [] },
      draft,
      "s1",
    );
    assert.ok("held" in res && res.held.includes("lint"));
    assert.deepEqual(calls, []);
  }
});

test("пост удалён в WP вручную: тема снята, пост не пересоздаётся; прочие ошибки WP летят дальше", async () => {
  for (const [status, body, gone] of [
    [404, '{"code":"rest_post_invalid_id"}', true],
    [500, '{"code":"internal_server_error"}', false],
  ] as const) {
    const { db } = setup();
    db.prepare("UPDATE drafts SET wp_post_id = 9209 WHERE id = 1").run();
    const calls: string[] = [];
    const wp = {
      uploadMedia: async (i: { filename: string }) => ({ id: 1, sourceUrl: `u/${i.filename}` }),
      createEntry: async () => {
        calls.push("create");
        return { id: 1, link: "l", slug: "s", status: "draft" };
      },
      updateEntry: async () => {
        throw new WpError("updateEntry", status, body);
      },
    } as unknown as WpClient;
    const draft = db.prepare("SELECT * FROM drafts WHERE id = 1").get() as never;
    const run = publishDraft(
      { db, cfg, wp, creds: { username: "u", appPassword: "p" }, styleFailures: () => [] },
      draft,
      "s1",
    );
    if (!gone) {
      await assert.rejects(run, /HTTP 500/);
      continue;
    }
    const res = await run;
    assert.ok("gone" in res && res.gone.includes("9209"));
    assert.deepEqual(calls, []);
    const c = db.prepare("SELECT status, score_reason FROM candidates WHERE id = 5").get() as {
      status: string;
      score_reason: string;
    };
    assert.equal(c.status, "rejected");
    assert.match(c.score_reason, /9209 удалён/);
    const d = db.prepare("SELECT wp_status FROM drafts WHERE id = 1").get() as {
      wp_status: string;
    };
    assert.equal(d.wp_status, "deleted");
  }
});

test("расписание: прошедший проверки черновик встаёт в future, проваленный в WP не уходит", async () => {
  const { db, dir } = setup();
  const calls: string[] = [];
  const wp = {
    uploadMedia: async (i: { filename: string }) => ({
      id: 1,
      sourceUrl: `https://k/${i.filename}`,
    }),
    createEntry: async () => ({
      id: 9300,
      link: "https://kafka-school.ru/?p=9300",
      slug: "s1",
      status: "draft",
    }),
    updateEntry: async (id: number) => ({
      id,
      link: "https://kafka-school.ru/?p=9300",
      slug: "s1",
      status: "draft",
    }),
    entryDates: async () => {
      calls.push("dates");
      return ["2026-11-18T08:00:00"];
    },
    publishEntry: async (id: number, _c: unknown, o: { dateGmt: string }) => {
      calls.push(`schedule ${id} ${o.dateGmt.slice(0, 10)}`);
      return { id, link: "https://kafka-school.ru/blog/s1/", slug: "s1", status: "future" };
    },
  } as unknown as WpClient;
  const on = { ...cfg, publish: { ...cfg.publish, status: "future" as const, lane: 0 } };
  const creds = { username: "u", appPassword: "p" };
  const draft = () => db.prepare("SELECT * FROM drafts WHERE id = 1").get() as never;
  const now = () => new Date("2026-11-18T11:40:00Z");

  writeFileSync(
    join(dir, ".work", "gates.json"),
    JSON.stringify({ ok: false, checks: {}, review: [] }),
  );
  const busy = { dates: null as string[] | null };
  const deps = { db, cfg: on, wp, creds, styleFailures: () => [], busy, now };
  assert.ok("held" in (await publishDraft(deps, draft(), "s1")));
  assert.deepEqual(calls, []);

  writeFileSync(
    join(dir, ".work", "gates.json"),
    JSON.stringify({ ok: true, checks: {}, review: [] }),
  );
  const res = (await publishDraft(deps, draft(), "s1")) as { status: string };
  assert.equal(res.status, "future");
  assert.deepEqual(calls, ["dates", "schedule 9300 2026-11-20"]);
  assert.deepEqual(busy.dates?.length, 2);
  const row = db.prepare("SELECT wp_status, wp_url FROM drafts WHERE id = 1").get() as never;
  assert.deepEqual(
    { ...(row as object) },
    { wp_status: "future", wp_url: "https://kafka-school.ru/blog/s1/" },
  );
});

test("конфиг: future без полосы — ошибка", () => {
  const base =
    "site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}\nselect: {keywords: [kafka]}\n";
  assert.throws(() => parseSiteConfig(`${base}publish: {status: future}\n`), /publish.lane/);
  assert.equal(parseSiteConfig(`${base}publish: {status: future, lane: 2}\n`).publish.lane, 2);
  assert.throws(() => parseSiteConfig(`${base}publish: {status: publish}\n`), /draft или future/);
});

test("корзина WP: DELETE без force, 410 «уже в корзине» не ошибка, 404 — пост удалён", async () => {
  const seen: string[] = [];
  const answer = (status: number, body: string) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)}`);
      return new Response(body, { status });
    }) as typeof fetch;
  const creds = { username: "u", appPassword: "p" };
  await trashPost("https://k/", creds, 9251, answer(200, '{"status":"trash"}'));
  assert.deepEqual(seen, ["DELETE https://k/wp-json/wp/v2/posts/9251"]);
  await trashPost("https://k", creds, 1, answer(410, '{"code":"rest_already_trashed"}'));
  await assert.rejects(
    trashPost("https://k", creds, 2, answer(404, '{"code":"rest_post_invalid_id"}')),
    (err) => postGone(err),
  );
  await assert.rejects(trashPost("https://k", creds, 3, answer(403, "{}")), /403/);
});
