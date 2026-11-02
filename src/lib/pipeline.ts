import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSecret } from "@techfriends-eng/toolkit/config";
import { fetchText } from "@techfriends-eng/toolkit/ingest";
import { createChat } from "@techfriends-eng/toolkit/llm";
import { createWp } from "@techfriends-eng/toolkit/wp";
import pg from "pg";
import { loadSiteConfig, type SiteConfig } from "./config/site.ts";
import { markBds, syncBds } from "./dedup/bds.ts";
import { markRadar, TAKEN_SQL } from "./dedup/radar.ts";
import { lint } from "./gates/checks.ts";
import { finish, gate, rework, slugOf, type GateDeps } from "./gates/run.ts";
import { refreshSource, writeDraft, type Candidate } from "./generate/draft.ts";
import { createJournal, type Journal, type Query } from "./journal/journal.ts";
import { BudgetExceeded, createLlm, OPENROUTER } from "./llm/client.ts";
import { publishDraft } from "./publish/wp.ts";
import { manualPath } from "./research/source.ts";
import { pick, score } from "./select/rank.ts";
import { prefilter } from "./select/prefilter.ts";
import { collect } from "./sources/collect.ts";
import { checkDraft } from "./stand/check.ts";
import { CANDIDATE_COLS, openState, type Db } from "./store/db.ts";
import { loadStyle } from "./style/rules.ts";
import { parse } from "yaml";
import { brandPreviewPrompt } from "./brand/brand.ts";
import { brandYaml, checkBrand, fetchSiteColors, suggestBrand } from "./brand/homepage.ts";
import { parseVisuals } from "./visuals/meta.ts";
import { generatePreview, PreviewFailed } from "./visuals/preview.ts";
import { dockerCli, finalizePreview, forgetSchemes, renderScheme } from "./visuals/render.ts";

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
/** Команды автора над готовыми черновиками: только с id кандидатов, в недельный прогон не входят. */
const DRAFT_COMMANDS = {
  rework: ["rework", "rerender", "visuals", "publish"],
  rerender: ["rerender", "visuals", "publish"],
} as const;
type DraftCommand = keyof typeof DRAFT_COMMANDS;
type AnyStep = Step | DraftCommand;

/**
 * Прогон начинает с визуализаций: обложки, что ждут с прошлого раза, получают деньги раньше новых статей.
 * Прогон у потолка иначе оставляет их без превью снова (kafka 2 ноября, $3,12 ушло до шага visuals).
 */
export const RUN_STEPS: Step[] = ["visuals", ...STEPS];
/** После потолка идут только шаги без платных вызовов: схемы и публикация уже готового. */
const AFTER_CEILING = new Set<AnyStep>(["rerender", "visuals", "publish"]);

const PKG = process.env.SAT_PKG_DIR ?? join(import.meta.dirname, "..", "..");
/** Сырые превью модели в корне черновика (до v0.1.16, в т. ч. «.jpg.raw» v0.1.10) линтер считает лишними файлами. */
function dropStrayPreviews(dir: string): void {
  for (const f of readdirSync(dir)) {
    if (/_preview\.jpg\.\w+$/.test(f)) rmSync(join(dir, f), { force: true });
  }
}

const VERSION = readFileSync(join(PKG, "VERSION"), "utf8").trim();

type Ctx = {
  db: Db;
  cfg: SiteConfig;
  journal: Journal;
  gateDeps: GateDeps;
  draftsDir: string;
  manualDir: string;
  ids?: number[];
  /** Превью, что не вышло в этом прогоне: второй проход visuals за него не платит. */
  previewFailed: Set<number>;
};

/** Сколько нечитаемых кандидатов заменять за прогон: ниже — следующий прогон. */
const MAX_UNREADABLE_PER_RUN = 10;

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
  const line = `${step} ${id}: ${(err as Error).message}`.slice(0, 300);
  if (!list.includes(line)) list.push(line); // visuals идёт дважды, сломанная схема — одна ошибка
}

/**
 * Шаги по порядку. Потолок останавливает платные шаги, но готовое уходит в WP, а не ждёт следующего
 * прогона. Любая другая ошибка останавливает прогон. Возвращает текст ошибки для журнала.
 */
export async function runSteps<S extends AnyStep>(
  steps: readonly S[],
  exec: (step: S) => Promise<void>,
  command: string,
): Promise<string | null> {
  let error: string | null = null;
  let ceiling = false;
  for (const step of steps) {
    if (ceiling && !AFTER_CEILING.has(step)) continue;
    try {
      await exec(step);
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
      console.error(`sat ${command}: ${(err as Error).stack ?? error}`);
      if (!(err instanceof BudgetExceeded)) {
        process.exitCode = 1;
        break;
      }
      ceiling = true;
    }
  }
  return error;
}

const run: Record<AnyStep, (ctx: Ctx) => Promise<void>> = {
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
    const { db, cfg, journal, manualDir } = ctx;
    const status = db.prepare("UPDATE candidates SET status = 'picked' WHERE id = ?");
    // Автор положил текст: кандидат возвращается в работу.
    const waiting = db.prepare("SELECT id FROM candidates WHERE status = 'unreadable'").all() as {
      id: number;
    }[];
    for (const { id } of waiting) {
      if (existsSync(manualPath(manualDir, id))) status.run(id);
    }
    const needText: { id: number; url: string; file: string }[] = [];
    const tried = new Set<number>();
    for (;;) {
      const rows = (
        db
          .prepare(`SELECT ${CANDIDATE_COLS} FROM candidates WHERE status = 'picked'`)
          .all() as Candidate[]
      ).filter((r) => !tried.has(r.id) && (!ctx.ids?.length || ctx.ids.includes(r.id)));
      let unreadable = 0;
      for (const row of rows) {
        tried.add(row.id);
        journal.touch(row.id);
        try {
          await writeDraft(
            {
              ...ctx.gateDeps,
              draftsDir: ctx.draftsDir,
              manualDir,
              getHtml: (u) => fetchText(u, 60_000, 2_000_000),
            },
            row,
          );
        } catch (err) {
          errorOf(ctx, "draft", row.id, err); // тема остаётся picked, попадёт в следующий прогон
        }
        const now = db.prepare("SELECT status FROM candidates WHERE id = ?").get(row.id) as {
          status: string;
        };
        if (now.status === "unreadable") {
          unreadable++;
          needText.push({ id: row.id, url: row.url, file: manualPath(manualDir, row.id) });
        }
      }
      // Вместо нечитаемого — следующий кандидат. Без замены прогон остался бы без статьи.
      if (!unreadable || ctx.ids?.length || needText.length >= MAX_UNREADABLE_PER_RUN) break;
      if (!pick(db, cfg).length) break;
    }
    if (needText.length) journal.stats.need_author_text = needText;
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
      dropStrayPreviews(d.dir);
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
    const { brand } = ctx.cfg;
    const base = JSON.parse(
      readFileSync(join(PKG, "visuals", "mermaid_theme_override.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const d of drafts(ctx.db, ["ready", "gate_failed"], ctx.ids)) {
      const slug = slugOf(d.dir);
      dropStrayPreviews(d.dir);
      const { preview, schemes } = parseVisuals(
        readFileSync(join(d.dir, `${slug}_meta.md`), "utf8"),
      );
      for (const s of schemes) {
        if (existsSync(join(d.dir, s.file))) continue;
        try {
          renderScheme(dockerCli, image, d.dir, uid, s.file, s.mermaid, { brand, base });
        } catch (err) {
          errorOf(ctx, `схема ${s.n}`, d.candidate_id, err);
        }
      }
      if (preview && !existsSync(join(d.dir, preview.file))) {
        if (ctx.previewFailed.has(d.candidate_id)) continue;
        const { llm } = ctx.gateDeps;
        if (llm.exhausted()) {
          errorOf(
            ctx,
            "превью",
            d.candidate_id,
            new Error("потолок прогона, ждёт следующий прогон"),
          );
          continue;
        }
        try {
          const img = await generatePreview({
            apiKey,
            models: [ctx.cfg.llm.models.image, "google/gemini-2.5-flash-image"],
            prompt: brandPreviewPrompt(preview.prompt, brand),
          });
          // Расход пишем до сборки JPEG: картинка оплачена, даже если сборка упадёт.
          llm.charge("image", img.model, img.costUsd, d.candidate_id);
          const raw = `.work/${preview.file}.${img.ext}`;
          writeFileSync(join(d.dir, raw), img.bytes);
          finalizePreview(dockerCli, image, d.dir, uid, raw, preview.file, brand.background);
        } catch (err) {
          if (err instanceof PreviewFailed && err.costUsd > 0) {
            llm.charge("image", ctx.cfg.llm.models.image, err.costUsd, d.candidate_id);
          }
          ctx.previewFailed.add(d.candidate_id);
          errorOf(ctx, "превью", d.candidate_id, err);
        }
      }
    }
  },
  async rework(ctx) {
    const row = ctx.db.prepare("SELECT id, url, summary, body FROM candidates WHERE id = ?");
    const list = (ctx.journal.stats.rework ??= []) as unknown[];
    const statusOf = ctx.db.prepare("SELECT status FROM candidates WHERE id = ?");
    for (const d of drafts(ctx.db, ["ready", "gate_failed", "ran", "run_failed"], ctx.ids)) {
      const slug = slugOf(d.dir);
      ctx.journal.touch(d.candidate_id);
      try {
        const cand = row.get(d.candidate_id) as Candidate;
        const src = await refreshSource(
          { manualDir: ctx.manualDir, getHtml: (u) => fetchText(u, 60_000, 2_000_000) },
          cand,
          d.dir,
          slug,
        );
        if (!src.ok) {
          errorOf(ctx, "rework", d.candidate_id, new Error(`исходник не прочитан: ${src.tried}`));
          continue;
        }
        const ok = await rework(ctx.gateDeps, d, slug);
        const { status } = statusOf.get(d.candidate_id) as { status: string };
        list.push({ id: d.candidate_id, source_words: src.words, ok, status });
      } catch (err) {
        errorOf(ctx, "rework", d.candidate_id, err);
      }
    }
  },
  async rerender(ctx) {
    const list = (ctx.journal.stats.rerender ??= []) as unknown[];
    for (const d of drafts(ctx.db, ["ready", "gate_failed"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      list.push({ id: d.candidate_id, schemes: forgetSchemes(d.dir).length });
    }
  },
  async publish(ctx) {
    const wp = createWp({ baseUrl: readSecret("WP_URL") });
    const creds = { username: readSecret("WP_USER"), appPassword: readSecret("WP_APP_PASSWORD") };
    const styleFailures = (dir: string, slug: string) =>
      lint(ctx.gateDeps.lintPy, dir, slug, ctx.cfg.domain, slug).style;
    for (const d of drafts(ctx.db, ["ready", "gate_failed"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        const res = await publishDraft(
          { db: ctx.db, cfg: ctx.cfg, wp, creds, styleFailures },
          d,
          slugOf(d.dir),
        );
        if ("blocked" in res) {
          const list = (ctx.journal.stats.style_blocked ??= []) as unknown[];
          list.push({ id: d.candidate_id, items: res.blocked.map((b) => b.slice(0, 200)) });
        }
      } catch (err) {
        errorOf(ctx, "publish", d.candidate_id, err);
      }
    }
  },
};

/** Предложение палитры: `--domain` у нового сайта, конфига которого ещё нет в разборе. */
async function brandSuggest(rest: string[]): Promise<number> {
  const at = rest.indexOf("--domain");
  const domain =
    at >= 0
      ? rest[at + 1]
      : (
          parse(
            readFileSync(
              join(process.env.SAT_SITE_DIR ?? process.cwd(), "config", "site.yaml"),
              "utf8",
            ),
          ) as { site?: { domain?: string } }
        ).site?.domain;
  if (!domain) throw new Error("brand-suggest: нужен --domain или site.domain в конфиге");
  const brand = suggestBrand(await fetchSiteColors(domain));
  if (!brand) {
    console.error(`${domain}: на главной нет цветов с оттенком, палитру задаёт автор`);
    return 1;
  }
  console.log(brandYaml(brand));
  return 0;
}

/** Сверка brand с главной страницей сайта. Выход 0 — сходится, 1 — нет или страница недоступна. */
async function brandCheck(): Promise<number> {
  const cfg = loadSiteConfig(
    join(process.env.SAT_SITE_DIR ?? process.cwd(), "config", "site.yaml"),
  );
  const res = checkBrand(cfg.brand, await fetchSiteColors(cfg.domain));
  console.log(`главная ${cfg.domain}: ${res.site.map((c) => c.hex).join(" ") || "цветов нет"}`);
  for (const p of res.problems) console.error(p);
  return res.ok ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  if (command === "brand-suggest") return brandSuggest(rest);
  if (command === "brand-check") return brandCheck();
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
  const draftCommand = DRAFT_COMMANDS[command as DraftCommand] as readonly AnyStep[] | undefined;
  if (draftCommand && !ids.length) {
    console.error(`sat ${command}: нужны id кандидатов`);
    return 2;
  }
  const steps: readonly AnyStep[] =
    draftCommand ??
    (command === "run"
      ? RUN_STEPS
      : command === "sync"
        ? []
        : STEPS.includes(command as Step)
          ? [command as Step]
          : []);
  if (!steps.length && command !== "sync") {
    console.error(
      `sat: неизвестная команда ${command}; есть run, sync, note, rework, rerender, brand-check, brand-suggest, ${STEPS.join(", ")}`,
    );
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
    manualDir: join(stateDir, "source-text"),
    previewFailed: new Set(),
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
  const error = await runSteps(steps, (step) => run[step](ctx), command);
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
