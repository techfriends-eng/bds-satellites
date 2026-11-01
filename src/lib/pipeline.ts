import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSecret } from "@techfriends-eng/toolkit/config";
import { fetchText } from "@techfriends-eng/toolkit/ingest";
import { createChat } from "@techfriends-eng/toolkit/llm";
import { createWp } from "@techfriends-eng/toolkit/wp";
import pg from "pg";
import { loadSiteConfig, type SiteConfig } from "./config/site.ts";
import { markBds, syncBds } from "./dedup/bds.ts";
import { markRadar, TAKEN_SQL } from "./dedup/radar.ts";
import { finish, gate, slugOf, type GateDeps } from "./gates/run.ts";
import { writeDraft, type Candidate } from "./generate/draft.ts";
import { createJournal, type Journal, type Query } from "./journal/journal.ts";
import { BudgetExceeded, createLlm, OPENROUTER } from "./llm/client.ts";
import { publishDraft } from "./publish/wp.ts";
import { pick, score } from "./select/rank.ts";
import { prefilter } from "./select/prefilter.ts";
import { collect } from "./sources/collect.ts";
import { checkDraft } from "./stand/check.ts";
import { CANDIDATE_COLS, openState, type Db } from "./store/db.ts";
import { loadStyle } from "./style/rules.ts";
import { parseVisuals } from "./visuals/meta.ts";
import { generatePreview } from "./visuals/preview.ts";
import { dockerCli, finalizePreview, renderScheme } from "./visuals/render.ts";

/**
 * Конвейер сайта целиком и по шагам. Пути — из окружения юнита (deploy/bds-sat-<site>.env.example):
 *   SAT_SITE_DIR   — клон репо сайта (config/site.yaml, prompts/site/)
 *   SAT_STATE_DIR  — состояние: state.db, drafts/, runs/ (/var/lib/bds-sat-<site>)
 *   SAT_PKG_DIR    — этот пакет (prompts/, style/, lint/, visuals/), по умолчанию рядом с src/
 * Секреты — readSecret (переменная или файл из NAME_FILE, handbook standards/05).
 */
export const STEPS = [
  "collect",
  "select",
  "draft",
  "stand",
  "gates",
  "revise",
  "visuals",
  "publish",
] as const;
export type Step = (typeof STEPS)[number];

const PKG = process.env.SAT_PKG_DIR ?? join(import.meta.dirname, "..", "..");
const VERSION = readFileSync(join(PKG, "VERSION"), "utf8").trim();

type Ctx = {
  db: Db;
  cfg: SiteConfig;
  journal: Journal;
  gateDeps: GateDeps;
  draftsDir: string;
  ids?: number[];
};

function optionalSecret(name: string): string | null {
  try {
    return readSecret(name);
  } catch {
    return null;
  }
}

async function pgQuery(url: string | null): Promise<Query | null> {
  if (!url) return null;
  return async (sql, params) => {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
}

function drafts(db: Db, statuses: string[], ids?: number[]) {
  const rows = db
    .prepare(
      `SELECT d.* FROM drafts d JOIN candidates c ON c.id = d.candidate_id
       WHERE c.status IN (${statuses.map(() => "?").join(",")}) ORDER BY d.id`,
    )
    .all(...statuses) as {
    id: number;
    candidate_id: number;
    dir: string;
    wp_post_id: number | null;
  }[];
  return ids?.length ? rows.filter((r) => ids.includes(r.candidate_id)) : rows;
}

function errorOf(ctx: Ctx, step: string, id: number, err: unknown): void {
  if (err instanceof BudgetExceeded) throw err;
  const list = (ctx.journal.stats.errors ??= []) as string[];
  list.push(`${step} ${id}: ${(err as Error).message}`.slice(0, 300));
}

const run: Record<Step, (ctx: Ctx) => Promise<void>> = {
  async collect(ctx) {
    const { db, cfg, journal } = ctx;
    const res = await collect(db, cfg, (url, timeout) => fetchText(url, timeout, 4_000_000));
    journal.stats.feeds = res.length;
    journal.stats.feed_errors = res.filter((r) => r.error).length;
    journal.stats.added = res.reduce((n, r) => n + r.added, 0);
    try {
      await syncBds(db, cfg.bdsBase, async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
        return { body: await r.json(), totalPages: Number(r.headers.get("x-wp-totalpages") ?? 1) };
      });
    } catch (err) {
      journal.stats.bds_error = (err as Error).message.slice(0, 200); // индекс доберётся в следующий раз
    }
    journal.stats.bds = markBds(db);
    const radar = await pgQuery(optionalSecret("STACKRADAR_RO_URL"));
    if (radar) {
      try {
        journal.stats.radar = await markRadar(db, async () =>
          ((await radar(TAKEN_SQL, [])) as { rows: { url: string }[] }).rows.map((r) => r.url),
        );
      } catch (err) {
        journal.stats.radar_error = (err as Error).message.slice(0, 200);
      }
    }
    journal.stats.prefilter = prefilter(db, cfg);
  },
  async select(ctx) {
    await score(ctx.db, ctx.cfg, ctx.gateDeps.llm, join(PKG, "prompts"));
    ctx.journal.stats.picked = pick(ctx.db, ctx.cfg);
  },
  async draft(ctx) {
    const rows = ctx.db
      .prepare(`SELECT ${CANDIDATE_COLS} FROM candidates WHERE status = 'picked'`)
      .all() as Candidate[];
    for (const row of rows.filter((r) => !ctx.ids?.length || ctx.ids.includes(r.id))) {
      ctx.journal.touch(row.id);
      try {
        await writeDraft(
          {
            ...ctx.gateDeps,
            draftsDir: ctx.draftsDir,
            getHtml: (u) => fetchText(u, 30_000, 2_000_000),
          },
          row,
        );
      } catch (err) {
        errorOf(ctx, "draft", row.id, err); // тема остаётся picked, попадёт в следующий прогон
      }
    }
  },
  async stand(ctx) {
    for (const d of drafts(ctx.db, ["drafted"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        await checkDraft(ctx.gateDeps, d, slugOf(d.dir));
      } catch (err) {
        errorOf(ctx, "stand", d.candidate_id, err);
      }
    }
  },
  async gates(ctx) {
    for (const d of drafts(ctx.db, ["ran", "run_failed"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        await gate(ctx.gateDeps, d, slugOf(d.dir));
      } catch (err) {
        errorOf(ctx, "gates", d.candidate_id, err);
      }
    }
  },
  async revise(ctx) {
    for (const d of drafts(ctx.db, ["gate_failed"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        await finish(ctx.gateDeps, d, slugOf(d.dir));
      } catch (err) {
        errorOf(ctx, "revise", d.candidate_id, err);
      }
    }
  },
  async visuals(ctx) {
    const image = `bds-sat-visuals:${VERSION}`;
    const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const apiKey = readSecret("OPENROUTER_API_KEY");
    for (const d of drafts(ctx.db, ["ready", "gate_failed"], ctx.ids)) {
      const slug = slugOf(d.dir);
      const { preview, schemes } = parseVisuals(
        readFileSync(join(d.dir, `${slug}_meta.md`), "utf8"),
      );
      for (const s of schemes) {
        if (existsSync(join(d.dir, s.file))) continue;
        try {
          renderScheme(dockerCli, image, d.dir, uid, s.file, s.mermaid);
        } catch (err) {
          errorOf(ctx, `схема ${s.n}`, d.candidate_id, err);
        }
      }
      if (preview && !existsSync(join(d.dir, preview.file))) {
        try {
          const img = await generatePreview({
            apiKey,
            models: [ctx.cfg.llm.models.image, "google/gemini-2.5-flash-image"],
            prompt: preview.prompt,
          });
          const raw = `${preview.file}.${img.ext}`;
          writeFileSync(join(d.dir, raw), img.bytes);
          finalizePreview(dockerCli, image, d.dir, uid, raw, preview.file);
          ctx.db
            .prepare(
              "INSERT INTO llm_calls (at, stage, model, candidate_id, cost_usd) VALUES (?, 'image', ?, ?, ?)",
            )
            .run(new Date().toISOString(), img.model, d.candidate_id, img.costUsd);
        } catch (err) {
          errorOf(ctx, "превью", d.candidate_id, err);
        }
      }
    }
  },
  async publish(ctx) {
    const wp = createWp({ baseUrl: readSecret("WP_URL") });
    const creds = { username: readSecret("WP_USER"), appPassword: readSecret("WP_APP_PASSWORD") };
    for (const d of drafts(ctx.db, ["ready", "gate_failed"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        await publishDraft({ db: ctx.db, cfg: ctx.cfg, wp, creds }, d, slugOf(d.dir));
      } catch (err) {
        errorOf(ctx, "publish", d.candidate_id, err);
      }
    }
  },
};

export async function main(argv: string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  if (rest.includes("--check-config")) {
    loadSiteConfig(join(process.env.SAT_SITE_DIR ?? process.cwd(), "config", "site.yaml"));
    return 0; // selfcheck: конфиг сайта разбирается
  }
  const ids = rest.filter((a) => /^\d+$/.test(a)).map(Number);
  const siteDir = process.env.SAT_SITE_DIR ?? process.cwd();
  const stateDir = process.env.SAT_STATE_DIR ?? join(siteDir, "state");
  const cfg = loadSiteConfig(join(siteDir, "config", "site.yaml"));
  if (process.env.SAT_STAND_BASE) cfg.stand.base = process.env.SAT_STAND_BASE;
  const db = openState(join(stateDir, "state.db"));
  const journal = createJournal(db, cfg, command);
  if (command === "note") {
    // Прогон без работы (пропуск обёрткой): запись в журнал хаба, чтобы сторож видел причину.
    const note = createJournal(db, cfg, "note");
    await note.close(await pgQuery(optionalSecret("SAT_DB_URL")), 0, rest.join(" ") || "note");
    return 0;
  }
  const steps: Step[] =
    command === "run"
      ? [...STEPS]
      : command === "sync"
        ? []
        : STEPS.includes(command as Step)
          ? [command as Step]
          : [];
  if (!steps.length && command !== "sync") {
    console.error(`sat: неизвестная команда ${command}; есть run, sync, note, ${STEPS.join(", ")}`);
    return 2;
  }
  const llm = createLlm(
    db,
    cfg,
    createChat({ baseUrl: OPENROUTER, apiKey: optionalSecret("OPENROUTER_API_KEY") ?? "" }),
  );
  const ctx: Ctx = {
    db,
    cfg,
    journal,
    ids,
    draftsDir: join(stateDir, "drafts"),
    gateDeps: {
      db,
      cfg,
      llm,
      style: loadStyle(join(PKG, "style")),
      promptDirs: [join(PKG, "prompts"), join(siteDir, "prompts", "site")],
      lintPy: join(PKG, "lint", "sat_lint.py"),
      head: async (url) =>
        (await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) })).status,
    },
  };
  if (command === "sync") {
    for (const d of drafts(db, ["drafted", "ran", "run_failed", "gate_failed", "ready"]))
      journal.touch(d.candidate_id);
  }
  let error: string | null = null;
  try {
    for (const step of steps) await run[step](ctx);
  } catch (err) {
    error = (err as Error).message.slice(0, 500);
    console.error(`sat ${command}: ${(err as Error).stack ?? error}`);
    if (!(err instanceof BudgetExceeded)) process.exitCode = 1;
  }
  journal.stats.cost_usd = Math.round(llm.spent() * 1000) / 1000;
  const errs = journal.stats.errors as string[] | undefined;
  await journal.close(
    await pgQuery(optionalSecret("SAT_DB_URL")),
    llm.spent(),
    error ?? (errs?.join("; ").slice(0, 500) || null),
  );
  console.log(JSON.stringify(journal.stats));
  // Ошибка отдельной статьи — в журнале и хабе; ненулевой код — только когда упал сам прогон (M4).
  return error && process.exitCode ? 1 : 0;
}
