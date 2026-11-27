import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import { openState } from "../store/db.ts";
import { urlHash } from "./keys.ts";
import { BDS_DECLINED, OFFER_INSERT_SQL, syncBdsOffers } from "./offers.ts";

const cfg = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
sources:
  - {id: yt, kind: youtube, channel_id: UC1}
select: {keywords: [kafka], bdsPerRun: 2, bdsMinRelevance: 9, bdsMinDepth: 7}
`);

/** Пул: url, релевантность, глубина, статус. */
function seed(rows: [string, number, number, string][]) {
  const db = openState(":memory:");
  const ins = db.prepare(
    `INSERT INTO candidates (url_hash, url, source_id, kind, title, summary, published, fetched_at,
       score_relevance, score_depth, score_reason, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const [url, rel, depth, status] of rows)
    ins.run(
      urlHash(url),
      url,
      "yt",
      "youtube",
      `t ${url}`,
      "<p>s</p>",
      "2026-11-01",
      "2026-11-20",
      rel,
      depth,
      "r",
      status,
    );
  return db;
}

/** Таблица sat.bds_offers в памяти: url_hash → {status, offered_at}. */
function fakeSat(rows: Record<string, { status: string; offered_at: string }>) {
  const inserted: unknown[][] = [];
  const query = async (sql: string, params: unknown[]) => {
    if (sql === OFFER_INSERT_SQL) {
      inserted.push(params);
      return { rows: [] };
    }
    const hashes = params[0] as string[];
    return { rows: hashes.filter((h) => rows[h]).map((h) => ({ url_hash: h, ...rows[h] })) };
  };
  return { query, inserted };
}

const status = (db: ReturnType<typeof openState>, url: string) =>
  (db.prepare("SELECT status FROM candidates WHERE url = ?").get(url) as { status: string }).status;

test("лучшие предлагаются BDS, сверх лимита — очередь, ниже порога не трогаются", async () => {
  const db = seed([
    ["https://y/a", 10, 9, "new"],
    ["https://y/b", 9, 7, "new"],
    ["https://y/c", 9, 8, "new"],
    ["https://y/d", 9, 6, "new"],
    ["https://y/e", 8, 9, "new"],
  ]);
  const sat = fakeSat({});
  const stats = await syncBdsOffers(db, cfg, sat.query, new Date("2026-11-23"));
  assert.deepEqual(stats, { offered: 2, queued: 1, pending: 0, bds: 0, returned: 0 });
  assert.deepEqual(
    sat.inserted.map((p) => p[2]),
    ["https://y/a", "https://y/c"],
  );
  assert.equal(sat.inserted[0][0], "kafka");
  assert.equal(sat.inserted[0][5], "s");
  assert.equal(status(db, "https://y/b"), "bds_offer");
  assert.equal(status(db, "https://y/d"), "new");
  assert.equal(status(db, "https://y/e"), "new");
});

test("сверка решений: approved → radar, rejected/expired/старый pending → new, свежий pending ждёт", async () => {
  const db = seed([
    ["https://y/ok", 10, 9, "bds_offer"],
    ["https://y/no", 10, 9, "bds_offer"],
    ["https://y/late", 10, 9, "bds_offer"],
    ["https://y/wait", 10, 9, "bds_offer"],
    ["https://y/stale", 10, 9, "bds_offer"],
    ["https://y/other", 9, 7, "new"],
  ]);
  const h = urlHash;
  const sat = fakeSat({
    [h("https://y/ok")]: { status: "approved", offered_at: "2026-11-20" },
    [h("https://y/no")]: { status: "rejected", offered_at: "2026-11-20" },
    [h("https://y/late")]: { status: "expired", offered_at: "2026-11-10" },
    [h("https://y/wait")]: { status: "pending", offered_at: "2026-11-20" },
    [h("https://y/stale")]: { status: "pending", offered_at: "2026-11-01" },
    // Тот же материал уже предложил другой спутник: строку не дублируем, ждём решения.
    [h("https://y/other")]: { status: "pending", offered_at: "2026-11-22" },
  });
  const stats = await syncBdsOffers(db, cfg, sat.query, new Date("2026-11-23"));
  assert.deepEqual(stats, { offered: 0, queued: 0, pending: 2, bds: 1, returned: 3 });
  assert.equal(sat.inserted.length, 0);
  assert.equal(status(db, "https://y/ok"), "radar");
  assert.equal(status(db, "https://y/no"), "new");
  assert.equal(status(db, "https://y/late"), "new");
  assert.equal(status(db, "https://y/stale"), "new");
  assert.equal(status(db, "https://y/wait"), "bds_offer");
  assert.equal(status(db, "https://y/other"), "bds_offer");

  // Повторная сверка: отданное спутнику снова не предлагается.
  const again = await syncBdsOffers(db, cfg, sat.query, new Date("2026-11-23"));
  assert.equal(again.offered, 0);
  assert.equal(status(db, "https://y/no"), "new");
});

test("пороги по умолчанию 8/6 (автор 2026-11-27), лимит 3, режим site", () => {
  const d = parseSiteConfig(`
site: {id: kafka, domain: kafka-school.ru}\nbrand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}
sources: []
select: {keywords: [kafka]}
`);
  assert.equal(d.select.bdsMinRelevance, 8);
  assert.equal(d.select.bdsMinDepth, 6);
  assert.equal(d.select.bdsPerRun, 3);
  assert.equal(d.mode, "site");
});

const BRAND =
  "brand: {primary: '#2F6F73', accent: '#A9CBD4', background: '#F4F8F9', text: '#232C3D'}";

test("mode: offers разбирается, чужое значение — ошибка", () => {
  const conf = (mode: string) =>
    `site: {id: bds, domain: bigdataschool.ru}\nmode: ${mode}\n${BRAND}\nselect: {keywords: [airflow]}\n`;
  assert.equal(parseSiteConfig(conf("offers")).mode, "offers");
  assert.throws(() => parseSiteConfig(conf("drafts")), /mode: drafts/);
});

test("режим offers: отказ и срок снимают тему (skip bds_declined), спутнику не возвращают", async () => {
  const offers = parseSiteConfig(
    `site: {id: bds, domain: bigdataschool.ru}\nmode: offers\n${BRAND}\nselect: {keywords: [airflow]}\n`,
  );
  const db = seed([
    ["https://y/no", 10, 9, "bds_offer"],
    ["https://y/late", 10, 9, "bds_offer"],
    ["https://y/ok", 10, 9, "bds_offer"],
  ]);
  const h = urlHash;
  const sat = fakeSat({
    [h("https://y/no")]: { status: "rejected", offered_at: "2026-11-20" },
    [h("https://y/late")]: { status: "expired", offered_at: "2026-11-10" },
    [h("https://y/ok")]: { status: "approved", offered_at: "2026-11-20" },
  });
  const stats = await syncBdsOffers(db, offers, sat.query, new Date("2026-11-23"));
  assert.deepEqual(stats, { offered: 0, queued: 0, pending: 0, bds: 1, returned: 2 });
  const row = (url: string) =>
    db.prepare("SELECT status, skip_reason FROM candidates WHERE url = ?").get(url) as {
      status: string;
      skip_reason: string | null;
    };
  assert.deepEqual({ ...row("https://y/no") }, { status: "skip", skip_reason: BDS_DECLINED });
  assert.deepEqual({ ...row("https://y/late") }, { status: "skip", skip_reason: BDS_DECLINED });
  assert.equal(row("https://y/ok").status, "radar");
  // Следующая сверка снятое не трогает и заново не предлагает.
  const again = await syncBdsOffers(db, offers, sat.query, new Date("2026-11-24"));
  assert.deepEqual(again, { offered: 0, queued: 0, pending: 0, bds: 0, returned: 0 });
});
