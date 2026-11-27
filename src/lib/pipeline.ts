import { abReport, formatAb } from "./llm/ab.ts";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSecret } from "@techfriends-eng/toolkit/config";
import { fetchText } from "@techfriends-eng/toolkit/ingest";
import { createChat, createLedger } from "@techfriends-eng/toolkit/llm";
import { createWp, WpError } from "@techfriends-eng/toolkit/wp";
import pg from "pg";
import { loadSiteConfig, type SiteConfig } from "./config/site.ts";
import { markBds, syncBds } from "./dedup/bds.ts";
import { markRadar, TAKEN_SQL } from "./dedup/radar.ts";
import { syncBdsOffers } from "./dedup/offers.ts";
import { lint } from "./gates/checks.ts";
import {
  align,
  aligned,
  finish,
  gate,
  revisionsDone,
  rework,
  slugOf,
  type GateDeps,
} from "./gates/run.ts";
import {
  MEDIUM_PAYWALL,
  refreshSource,
  videoReader,
  writeDraft,
  type Candidate,
} from "./generate/draft.ts";
import { createJournal, type Journal, type Query } from "./journal/journal.ts";
import { createClaudeCli } from "./llm/claude-cli.ts";
import {
  BudgetExceeded,
  createLlm,
  OPENROUTER,
  OPENROUTER_THROW_ON,
  parseModel,
  TIMER_COMMANDS,
  weekSpent,
} from "./llm/client.ts";
import { postGone, publishDraft, trashPost, unschedulePost } from "./publish/wp.ts";
import { manualPath, mediumFeedUrl } from "./research/source.ts";
import { pick, score } from "./select/rank.ts";
import { prefilter } from "./select/prefilter.ts";
import { adopt } from "./sources/adopt.ts";
import { collect } from "./sources/collect.ts";
import { checkDraft } from "./stand/check.ts";
import { CANDIDATE_COLS, nowIso, openState, type Db } from "./store/db.ts";
import { weekStart } from "./schedule.ts";
import { loadStyle } from "./style/rules.ts";
import { parse } from "yaml";
import { brandPreviewPrompt } from "./brand/brand.ts";
import { brandYaml, checkBrand, fetchSiteColors, suggestBrand } from "./brand/homepage.ts";
import { generatePreview, parseVisuals, PreviewFailed } from "@techfriends-eng/toolkit/visuals";
import { dockerCli, finalizePreview, forgetSchemes, renderScheme } from "./visuals/render.ts";

/**
 * Конвейер сайта целиком и по шагам. Пути — из окружения юнита (deploy/bds-sat-<site>.env.example):
 *   SAT_SITE_DIR   — клон репо сайта (config/site.yaml, prompts/site/)
 *   SAT_STATE_DIR  — состояние: state.db, drafts/, runs/ (/var/lib/bds-sat-<site>)
 *   SAT_PKG_DIR    — этот пакет (prompts/, style/, lint/, visuals/), по умолчанию рядом с src/
 * Секреты — readSecret (переменная или файл из NAME_FILE, handbook standards/05).
 */
/**
 * Модели превью (ADR 0002): список `llm.models.image` сайта. Задана одна — откат на вторую модель пары.
 * Раньше откат был жёстко 2.5-flash, и при основной 2.5-flash отката не было бы вовсе.
 */
export const IMAGE_MODELS = ["google/gemini-2.5-flash-image", "google/gemini-3-pro-image-preview"];

export function imageModels(models: string[]): string[] {
  const ids = models.map((m) => parseModel(m).id);
  return ids.length > 1 ? ids : [...ids, ...IMAGE_MODELS.filter((m) => !ids.includes(m))];
}

export const STEPS = [
  "collect",
  "select",
  "draft",
  "stand",
  "align",
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
  regate: ["regate", "publish"],
} as const;
type DraftCommand = keyof typeof DRAFT_COMMANDS;
type AnyStep = Step | DraftCommand;

/**
 * Прогон начинает с визуализаций: обложки, что ждут с прошлого раза, получают деньги раньше новых статей.
 * Прогон у потолка иначе оставляет их без превью снова (kafka 2 ноября, $3,12 ушло до шага visuals).
 */
export const RUN_STEPS: Step[] = ["visuals", ...STEPS];
/**
 * Такт (ADR 0002 §3): таймер сайта срабатывает несколько раз в сутки, за такт у темы не больше одного
 * шага из draft, stand, align, gates, revise. Превью, схемы и публикация готового идут в том же такте.
 * Новые темы (collect, select) — первым тактом недели сайта.
 */
export function tickSteps(newTopics: boolean): Step[] {
  return newTopics ? RUN_STEPS : RUN_STEPS.filter((s) => s !== "collect" && s !== "select");
}
/**
 * Режим offers (ADR 0005 п. 5): только сбор и отбор в `sat.bds_offers`, каждым тактом — предложения BDS не ждут
 * недели. Шаги черновика и команды над ним в этом режиме — ошибка команды; null — команда не годится.
 */
export const OFFER_STEPS: Step[] = ["collect", "select"];

export function offerSteps(command: string): Step[] | null {
  if (command === "run" || command === "tick") return OFFER_STEPS;
  if ((OFFER_STEPS as string[]).includes(command)) return [command as Step];
  return null;
}
/** Время последнего выбора тем (ISO UTC) в каталоге состояния: тактам не нужно выбирать темы снова. */
const SELECTED_AT = "selected-at";
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
  /** `--force`: ручная доработка темы с выбранным потолком правок. Ставит только автор. */
  force?: boolean;
  /** Превью, что не вышло в этом прогоне: второй проход visuals за него не платит. */
  previewFailed: Set<number>;
  stateDir: string;
  /** Такт: темы, что уже сделали шаг; null — прогон без ограничения шагов. */
  advanced: Set<number> | null;
};

/** Такт: можно ли теме сделать шаг. Да — шаг засчитан. */
function stepAllowed(ctx: Ctx, id: number): boolean {
  if (!ctx.advanced) return true;
  if (ctx.advanced.has(id)) return false;
  ctx.advanced.add(id);
  return true;
}

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
      `SELECT d.*, c.status FROM drafts d JOIN candidates c ON c.id = d.candidate_id
       WHERE c.status IN (${statuses.map(() => "?").join(",")}) ORDER BY d.id`,
    )
    .all(...statuses) as {
    id: number;
    candidate_id: number;
    dir: string;
    wp_post_id: number | null;
    wp_status: string | null;
    status: string;
  }[];
  return ids?.length ? rows.filter((r) => ids.includes(r.candidate_id)) : rows;
}

/** Статусы темы, по которым конвейер ещё работает. */
const ACTIVE = ["drafted", "ran", "run_failed", "gate_failed", "ready"];

/**
 * Пост вышел на сайте — статья принята автором (решение 21.11): тема переходит в конечный статус
 * `published`. Её больше не проверяют, не правят, не обновляют в WP и не пишут о ней ошибок.
 * Переделать вышедший пост — только явной командой `sat adopt`. Возвращает снятые с работы id.
 */
export function acceptLive(db: Db): number[] {
  const rows = db
    .prepare(
      `SELECT c.id FROM candidates c JOIN drafts d ON d.candidate_id = c.id
       WHERE d.wp_status = 'publish' AND c.status IN (${ACTIVE.map(() => "?").join(",")})`,
    )
    .all(...ACTIVE) as { id: number }[];
  const set = db.prepare("UPDATE candidates SET status = 'published' WHERE id = ?");
  for (const r of rows) set.run(r.id);
  return rows.map((r) => r.id);
}

/**
 * Статус постов WP незакрытых тем — с сайта, а не из state.db: пост мог выйти по расписанию, его мог
 * опубликовать автор руками, у темы из `sat adopt` статуса в базе нет вовсе (kafka 724, 21.11). Вышедший
 * пост — тема принята (acceptLive). Сбой WP по одному посту не мешает остальным.
 */
export async function syncLive(
  db: Db,
  status: (postId: number) => Promise<{ status: string; link: string }>,
): Promise<number[]> {
  const rows = db
    .prepare(
      `SELECT d.id, d.wp_post_id FROM drafts d JOIN candidates c ON c.id = d.candidate_id
       WHERE d.wp_post_id IS NOT NULL AND coalesce(d.wp_status, '') NOT IN ('publish', 'deleted')
         AND c.status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY d.id`,
    )
    .all(...ACTIVE) as { id: number; wp_post_id: number }[];
  const set = db.prepare("UPDATE drafts SET wp_status = 'publish', wp_url = ? WHERE id = ?");
  for (const r of rows) {
    try {
      const now = await status(r.wp_post_id);
      if (now.status === "publish") set.run(now.link, r.id);
    } catch (err) {
      console.error(`статус поста WP ${r.wp_post_id}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return acceptLive(db);
}

/**
 * Потолок правок выбран, а проверки не пройдены: тема снимается, вместо неё берётся следующая из пула
 * (ADR 0004, решение автора 21.11). Без этого черновик висел в gate_failed и ждал рук автора. Пост в WP,
 * если он не вышел, убирает в корзину `trashRejected`. Вернуть тему — `sat rework <id> --force`.
 */
export function dropExhausted(
  ctx: Pick<Ctx, "db" | "cfg" | "ids"> & { journal: { stats: Record<string, unknown> } },
  id: number,
): void {
  const { db, cfg } = ctx;
  const { status } = db.prepare("SELECT status FROM candidates WHERE id = ?").get(id) as {
    status: string;
  };
  if (status !== "gate_failed") return; // стенд не прошёл — это не провал текста
  const done = revisionsDone(db, id);
  if (done < cfg.gates.maxRevisionsTotal) return;
  const reason = `проверки не пройдены за ${done} правок, тема снята`;
  db.prepare("UPDATE candidates SET status = 'rejected', score_reason = ? WHERE id = ?").run(
    reason,
    id,
  );
  const list = (ctx.journal.stats.dropped ??= []) as unknown[];
  list.push({ id, reason, replacement: ctx.ids?.length ? [] : pick(db, cfg, 1) });
}

/**
 * Такт снимает все темы с выбранным потолком, а не только те, что правились в этом такте: правка у
 * таких тем уже не идёт, и они висели в gate_failed (kafka «MirrorMaker 2 и перенос позиции
 * консьюмера…», 6 правок при потолке 4, 21.11).
 */
export function sweepExhausted(
  ctx: Pick<Ctx, "db" | "cfg" | "ids"> & { journal: { stats: Record<string, unknown> } },
): void {
  for (const d of drafts(ctx.db, ["gate_failed"])) dropExhausted(ctx, d.candidate_id);
}

export type WpPostOps = {
  status: (postId: number) => Promise<{ status: string; link: string }>;
  trash: (postId: number) => Promise<void>;
  /** Снять с расписания в черновик: запасной ход, когда корзину WP не даёт роль пользователя. */
  unschedule: (postId: number) => Promise<void>;
};

/** WP не даёт роли удалить пост (author и пост в расписании, 21.11 kafka и spark): 403 rest_cannot_delete. */
function deleteDenied(err: unknown): boolean {
  return err instanceof WpError && err.status === 403 && err.message.includes("rest_cannot_delete");
}

/**
 * У автора в WP только два исхода темы: пост в расписании (или вышел) либо поста нет (решение 21.11).
 * Невышедший пост снятой темы (черновик, расписание, на проверке) уходит в корзину WP, оттуда автор
 * может его вернуть. Вышедший пост — статья принята автором: тема `published`, пост не трогаем.
 * Пост, удалённый вручную, отмечается `deleted`. Корзину не дала роль WP — пост из расписания
 * снимается в черновик (брак не выходит), попытка корзины повторится следующим прогоном.
 */
export async function trashRejected(
  db: Db,
  wp: WpPostOps,
): Promise<{ trashed: number[]; denied: number[] }> {
  const rows = db
    .prepare(
      `SELECT d.id, d.candidate_id, d.wp_post_id FROM drafts d JOIN candidates c ON c.id = d.candidate_id
       WHERE c.status = 'rejected' AND d.wp_post_id IS NOT NULL
         AND coalesce(d.wp_status, '') NOT IN ('deleted', 'trash', 'publish') ORDER BY d.id`,
    )
    .all() as { id: number; candidate_id: number; wp_post_id: number }[];
  const setWp = db.prepare(
    "UPDATE drafts SET wp_status = ?, wp_url = coalesce(?, wp_url) WHERE id = ?",
  );
  const trashed: number[] = [];
  const denied: number[] = [];
  for (const r of rows) {
    try {
      const now = await wp.status(r.wp_post_id);
      if (now.status === "publish") {
        setWp.run("publish", now.link, r.id);
        db.prepare("UPDATE candidates SET status = 'published' WHERE id = ?").run(r.candidate_id);
        continue;
      }
      if (now.status !== "trash") {
        try {
          await wp.trash(r.wp_post_id);
        } catch (err) {
          if (!deleteDenied(err)) throw err;
          if (now.status !== "draft") await wp.unschedule(r.wp_post_id);
          setWp.run("draft", null, r.id);
          denied.push(r.candidate_id);
          continue;
        }
        trashed.push(r.candidate_id);
      }
      setWp.run("trash", null, r.id);
    } catch (err) {
      if (postGone(err)) {
        setWp.run("deleted", null, r.id);
        continue;
      }
      console.error(`корзина WP ${r.wp_post_id}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return { trashed, denied };
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
    // ADR 0005: лучшие сначала предлагаются BDS. База недоступна — без добора тем: иначе лучшее
    // ушло бы в черновик спутника мимо BDS. Следующий отбор повторит.
    const sat = await pgQuery(optionalSecret("SAT_DB_URL"));
    // Режиму offers без базы делать нечего: это сбой прогона, а не тихий пропуск.
    if (!sat && ctx.cfg.mode === "offers") throw new Error("mode offers: нет SAT_DB_URL");
    if (sat) {
      try {
        ctx.journal.stats.bds_offers = await syncBdsOffers(ctx.db, ctx.cfg, sat);
      } catch (err) {
        ctx.journal.stats.bds_offers_error = (err as Error).message.slice(0, 200);
        if (ctx.cfg.mode === "offers") throw err;
        return;
      }
    }
    if (ctx.cfg.mode === "offers") return; // черновиков нет: темы не добираются
    ctx.journal.stats.picked = pick(ctx.db, ctx.cfg);
    writeFileSync(join(ctx.stateDir, SELECTED_AT), nowIso());
  },
  async draft(ctx) {
    const { db, cfg, journal, manualDir } = ctx;
    const status = db.prepare("UPDATE candidates SET status = 'picked' WHERE id = ?");
    // Автор положил текст: кандидат возвращается в работу.
    const waiting = db
      .prepare("SELECT id, url FROM candidates WHERE status = 'unreadable'")
      .all() as { id: number; url: string }[];
    const paywall = db.prepare(
      `UPDATE candidates SET status = 'skip', skip_reason = '${MEDIUM_PAYWALL}' WHERE id = ?`,
    );
    for (const { id, url } of waiting) {
      if (existsSync(manualPath(manualDir, id))) status.run(id);
      // Ждавшие текст статьи Medium до 0.1.57: автор их не носит.
      else if (mediumFeedUrl(url)) paywall.run(id);
    }
    const needText: { id: number; url: string; file: string }[] = [];
    const paywalled: number[] = [];
    const tried = new Set<number>();
    for (;;) {
      const rows = (
        db
          .prepare(`SELECT ${CANDIDATE_COLS} FROM candidates WHERE status = 'picked'`)
          .all() as Candidate[]
      ).filter(
        (r) =>
          !tried.has(r.id) &&
          !ctx.advanced?.has(r.id) &&
          (!ctx.ids?.length || ctx.ids.includes(r.id)),
      );
      let unreadable = 0;
      for (const row of rows) {
        tried.add(row.id);
        stepAllowed(ctx, row.id);
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
        } else if (now.status === "skip") {
          unreadable++; // платная статья Medium: замена без просьбы к автору
          paywalled.push(row.id);
        }
      }
      // Вместо нечитаемого — следующий кандидат. Без замены прогон остался бы без статьи.
      if (
        !unreadable ||
        ctx.ids?.length ||
        needText.length + paywalled.length >= MAX_UNREADABLE_PER_RUN
      )
        break;
      if (!pick(db, cfg).length) break;
    }
    if (needText.length) journal.stats.need_author_text = needText;
    if (paywalled.length) journal.stats.medium_paywall = paywalled;
  },
  async stand(ctx) {
    for (const d of drafts(ctx.db, ["drafted"], ctx.ids)) {
      if (!stepAllowed(ctx, d.candidate_id)) continue;
      ctx.journal.touch(d.candidate_id);
      try {
        await checkDraft(ctx.gateDeps, d, slugOf(d.dir));
      } catch (err) {
        errorOf(ctx, "stand", d.candidate_id, err);
      }
    }
  },
  async align(ctx) {
    for (const d of drafts(ctx.db, ["ran"], ctx.ids)) {
      if (aligned(d.dir) || !stepAllowed(ctx, d.candidate_id)) continue;
      ctx.journal.touch(d.candidate_id);
      try {
        await align(ctx.gateDeps, d, slugOf(d.dir));
      } catch (err) {
        errorOf(ctx, "align", d.candidate_id, err);
      }
    }
  },
  async gates(ctx) {
    for (const d of drafts(ctx.db, ["ran", "run_failed"], ctx.ids)) {
      // Стенд прошёл, а текст ещё не сверен с выводом (ADR 0003): проверка подождёт шага align.
      if (d.status === "ran" && !aligned(d.dir)) continue;
      if (!stepAllowed(ctx, d.candidate_id)) continue;
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
      if (!stepAllowed(ctx, d.candidate_id)) continue;
      ctx.journal.touch(d.candidate_id);
      dropStrayPreviews(d.dir);
      try {
        if (await finish(ctx.gateDeps, d, slugOf(d.dir))) continue;
        dropExhausted(ctx, d.candidate_id);
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
    if (!brand) throw new Error("visuals: в конфиге нет brand");
    const base = JSON.parse(
      readFileSync(join(PKG, "visuals", "mermaid_theme_override.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const d of drafts(ctx.db, ["ready"], ctx.ids)) {
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
            new Error(`${llm.ceiling() ?? "потолок прогона"}, ждёт следующий прогон`),
          );
          continue;
        }
        try {
          const img = await generatePreview({
            apiKey,
            models: imageModels(ctx.cfg.llm.models.image),
            prompt: brandPreviewPrompt(preview.prompt, brand),
          });
          // Расход пишем до сборки JPEG: картинка оплачена, даже если сборка упадёт.
          llm.charge("image", img.model, img.costUsd, d.candidate_id);
          const raw = `.work/${preview.file}.${img.ext}`;
          writeFileSync(join(d.dir, raw), img.bytes);
          finalizePreview(dockerCli, image, d.dir, uid, raw, preview.file, brand.background);
        } catch (err) {
          if (err instanceof PreviewFailed && err.costUsd > 0) {
            llm.charge(
              "image",
              imageModels(ctx.cfg.llm.models.image)[0],
              err.costUsd,
              d.candidate_id,
              false,
            );
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
    // rejected — тема, снятая после потолка правок (ADR 0004): автор возвращает её явным id.
    for (const d of drafts(
      ctx.db,
      ["ready", "gate_failed", "ran", "run_failed", "rejected"],
      ctx.ids,
    )) {
      const slug = slugOf(d.dir);
      ctx.journal.touch(d.candidate_id);
      // Потолок выбран — ручная доработка только по слову автора (21.11: две лишние правки ушли
      // на тему, которую текстом не спасти).
      const done = revisionsDone(ctx.db, d.candidate_id);
      if (done >= ctx.cfg.gates.maxRevisionsTotal && !ctx.force) {
        list.push({ id: d.candidate_id, refused: `правок ${done}, потолок выбран; нужен --force` });
        continue;
      }
      try {
        const cand = row.get(d.candidate_id) as Candidate;
        const src = await refreshSource(
          {
            manualDir: ctx.manualDir,
            getHtml: (u) => fetchText(u, 60_000, 2_000_000),
            video: videoReader({ ...ctx.gateDeps, draftsDir: ctx.draftsDir }, d.candidate_id),
          },
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
  /**
   * `sat regate <id…>`: проверки заново, без правки текста. Для отчётов, записанных до v0.1.38: тогда
   * серьёзность ставила модель, а потолок правок (gates.maxRevisionsTotal) у таких черновиков уже
   * выбран, и тактом их больше никто не перепроверит. Прошла — ready, дальше публикация.
   */
  async regate(ctx) {
    const list = (ctx.journal.stats.regate ??= []) as unknown[];
    for (const d of drafts(ctx.db, ["gate_failed", "ready"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        const r = await gate(ctx.gateDeps, d, slugOf(d.dir));
        list.push({
          id: d.candidate_id,
          ok: r.ok,
          failed: Object.keys(r.checks).filter((k) => !r.checks[k].ok),
        });
      } catch (err) {
        errorOf(ctx, "regate", d.candidate_id, err);
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
    const busy = { dates: null as string[] | null };
    for (const d of drafts(ctx.db, ["ready"], ctx.ids)) {
      ctx.journal.touch(d.candidate_id);
      try {
        // Пост в расписании мог выйти: вышедший не обновляем, тема принята (acceptLive).
        if (d.wp_post_id && d.wp_status === "future") {
          const now = await wp.getEntryStatus(d.wp_post_id, creds);
          if (now.status === "publish") {
            ctx.db
              .prepare("UPDATE drafts SET wp_status = 'publish', wp_url = ? WHERE id = ?")
              .run(now.link, d.id);
            acceptLive(ctx.db);
            continue;
          }
        }
        const res = await publishDraft(
          { db: ctx.db, cfg: ctx.cfg, wp, creds, styleFailures, busy },
          d,
          slugOf(d.dir),
        );
        if ("held" in res) {
          const list = (ctx.journal.stats.gate_held ??= []) as unknown[];
          list.push({ id: d.candidate_id, reason: res.held });
        } else if ("gone" in res) {
          const list = (ctx.journal.stats.wp_gone ??= []) as unknown[];
          list.push({ id: d.candidate_id, reason: res.gone });
        } else if ("blocked" in res) {
          const list = (ctx.journal.stats.style_blocked ??= []) as unknown[];
          list.push({ id: d.candidate_id, items: res.blocked.map((b) => b.slice(0, 200)) });
        } else if (res.status === "publish") {
          acceptLive(ctx.db);
        } else if (res.status === "future" && d.wp_status !== "future") {
          const list = (ctx.journal.stats.scheduled ??= []) as unknown[];
          list.push({ id: d.candidate_id, post: res.id });
        }
      } catch (err) {
        errorOf(ctx, "publish", d.candidate_id, err);
      }
    }
  },
};

/**
 * `sat adopt <id поста WP> <url исходника> [заголовок…]` (ToDo 97): старый пост переделывается по
 * новым правилам. Кандидат встаёт в picked, дальше обычные такты; публикация обновит этот пост.
 */
async function adoptCommand(db: Db, rest: string[]): Promise<number> {
  const [idArg, url, ...titleWords] = rest;
  const wpPostId = Number(idArg);
  if (!Number.isInteger(wpPostId) || wpPostId <= 0 || !/^https?:\/\//.test(url ?? "")) {
    console.error("sat adopt: нужно <id поста WP> <url исходника> [заголовок]");
    return 2;
  }
  const wp = createWp({ baseUrl: readSecret("WP_URL") });
  const creds = { username: readSecret("WP_USER"), appPassword: readSecret("WP_APP_PASSWORD") };
  const post = await wp.getEntryStatus(wpPostId, creds); // нет поста — ошибка WP, привязки нет
  const res = adopt(db, { wpPostId, url, title: titleWords.join(" ") || url });
  console.log(
    JSON.stringify({
      candidate: res.candidateId,
      created: res.created,
      wp_post_id: post.id,
      wp_status: post.status,
      link: post.link,
    }),
  );
  return 0;
}

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
  if (!cfg.brand) {
    console.log(`brand не задан: mode ${cfg.mode}, схем и превью нет`);
    return 0;
  }
  const res = checkBrand(cfg.brand, await fetchSiteColors(cfg.domain));
  console.log(`главная ${cfg.domain}: ${res.site.map((c) => c.hex).join(" ") || "цветов нет"}`);
  for (const p of res.problems) console.error(p);
  return res.ok ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  if (command === "brand-suggest") return brandSuggest(rest);
  if (command === "brand-check") return brandCheck();
  if (command === "mode") {
    // ops-скрипты (selfcheck, deploy-site) решают по нему, нужны ли Docker, образ и WP.
    console.log(
      loadSiteConfig(join(process.env.SAT_SITE_DIR ?? process.cwd(), "config", "site.yaml")).mode,
    );
    return 0;
  }
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
  const accepted = acceptLive(db);
  if (optionalSecret("WP_URL")) {
    const wp = createWp({ baseUrl: readSecret("WP_URL") });
    const creds = { username: readSecret("WP_USER"), appPassword: readSecret("WP_APP_PASSWORD") };
    accepted.push(...(await syncLive(db, (id) => wp.getEntryStatus(id, creds))));
  }
  for (const id of accepted) journal.touch(id);
  if (accepted.length) journal.stats.accepted = accepted;
  if ((TIMER_COMMANDS as readonly string[]).includes(command) || command === "sync") {
    sweepExhausted({ db, cfg, ids: [], journal });
    if (optionalSecret("WP_URL")) {
      const baseUrl = readSecret("WP_URL");
      const wp = createWp({ baseUrl });
      const creds = { username: readSecret("WP_USER"), appPassword: readSecret("WP_APP_PASSWORD") };
      const { trashed, denied } = await trashRejected(db, {
        status: (id) => wp.getEntryStatus(id, creds),
        trash: (id) => trashPost(baseUrl, creds, id),
        unschedule: (id) => unschedulePost(baseUrl, creds, id),
      });
      for (const id of [...trashed, ...denied]) journal.touch(id);
      if (trashed.length) journal.stats.wp_trashed = trashed;
      // Роль WP не даёт корзину: пост снят с расписания, удалить его может автор или админ сайта.
      if (denied.length) journal.stats.wp_trash_denied = denied;
    }
  }
  if (command === "ab-report") {
    console.log(formatAb(abReport(db)));
    return 0;
  }
  if (command === "adopt") return adoptCommand(db, rest);
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
  const week = weekStart(cfg.schedule.day);
  let selectedAt = "";
  try {
    selectedAt = readFileSync(join(stateDir, SELECTED_AT), "utf8").trim();
  } catch {
    // До v0.1.36 метки не было: время выбора — последняя оценка кандидата, иначе первый такт выберет темы снова.
    selectedAt =
      (db.prepare("SELECT MAX(scored_at) AS t FROM candidates").get() as { t: string | null }).t ??
      "";
  }
  const modeSteps = cfg.mode === "offers" && command !== "sync" ? offerSteps(command) : undefined;
  if (modeSteps === null) {
    console.error(
      `sat ${command}: в режиме offers есть только run, tick, sync, note, ${OFFER_STEPS.join(", ")}`,
    );
    return 2;
  }
  const steps: readonly AnyStep[] =
    modeSteps ??
    draftCommand ??
    (command === "run"
      ? RUN_STEPS
      : command === "tick"
        ? tickSteps(selectedAt < week)
        : command === "sync"
          ? []
          : STEPS.includes(command as Step)
            ? [command as Step]
            : []);
  if (!steps.length && command !== "sync") {
    console.error(
      `sat: неизвестная команда ${command}; есть run, tick, sync, note, adopt, rework, rerender, regate, brand-check, brand-suggest, mode, ${STEPS.join(", ")}`,
    );
    return 2;
  }
  const llm = createLlm(
    db,
    cfg,
    createChat({
      baseUrl: OPENROUTER,
      apiKey: optionalSecret("OPENROUTER_API_KEY") ?? "",
      throwOn: OPENROUTER_THROW_ON,
    }),
    // Общий журнал расхода llm.calls на supan8n; DSN нет — выключен (bds-content ADR 0001, шаг 5c).
    createLedger({
      project: "bds-satellites",
      query: await pgQuery(optionalSecret("LLM_LEDGER_DB_URL")),
    }),
    // Подписка Claude (ADR 0002): токен из CLAUDE_CODE_OAUTH_TOKEN или _FILE; нет — claude-cli
    // откатывается на следующую модель этапа.
    createClaudeCli(cfg.llm.claudeCli, join(stateDir, "claude-limits.json"), {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: optionalSecret("CLAUDE_CODE_OAUTH_TOKEN") ?? undefined,
    }),
    // Потолок недели — у прогонов по таймеру; команды автора над черновиками его не ждут
    // и в расход тактов не входят.
    (TIMER_COMMANDS as readonly string[]).includes(command) ? weekSpent(db, week) : null,
    command,
  );
  const ctx: Ctx = {
    db,
    cfg,
    journal,
    ids,
    force: rest.includes("--force"),
    stateDir,
    advanced: command === "tick" ? new Set() : null,
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
    // Все темы с черновиком и снятые: журнал и учёт правок (ledger) для недельного отчёта о браке.
    const all = db
      .prepare(
        "SELECT id FROM candidates WHERE status = 'rejected' OR id IN (SELECT candidate_id FROM drafts)",
      )
      .all() as { id: number }[];
    for (const r of all) journal.touch(r.id);
  }
  const error = await runSteps(steps, (step) => run[step](ctx), command);
  await llm.flush();
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
