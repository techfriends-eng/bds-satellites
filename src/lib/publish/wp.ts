import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WpError, type WpClient, type WpCredentials } from "@techfriends-eng/toolkit/wp";
import type { SiteConfig } from "../config/site.ts";
import type { GatesReport } from "../gates/run.ts";
import { draftPaths } from "../generate/draft.ts";
import type { Db } from "../store/db.ts";
import { parseVisuals } from "@techfriends-eng/toolkit/visuals";
import { leadTermsOf, normalizeArticle } from "../article/html.ts";
import { pickSlot } from "./slot.ts";

/**
 * Статья в WordPress сайта через toolkit/wp. Пост создаётся черновиком. При publish.status future
 * черновик, прошедший все проверки, встаёт в расписание WP (ToDo 98, время — publish/slot.ts).
 * Картинки (схемы и превью) — в медиатеку, TODO_IMAGE заменяется адресом. Ссылки на курсы
 * получают UTM. В WP уходит только статья, прошедшая все проверки (ADR 0004, решение автора 21.11):
 * провал не создаёт пост и не обновляет уже созданный, тема дорабатывается или снимается конвейером.
 * Стиль (STYLE_ITEMS линтера) проверяется заново: gates.json мог устареть с прошлого релиза.
 * Повторная публикация обновляет тот же пост (drafts.wp_post_id) и ставит обложку, если она появилась.
 */
export function withUtm(html: string, domain: string, slug: string): string {
  const q = new URLSearchParams({ utm_source: "sat", utm_medium: "article", utm_campaign: slug });
  const re = new RegExp(`href="(https?://${domain.replace(/\./g, "\\.")}/courses/[^"?#]*)"`, "g");
  return html.replace(
    re,
    (_m, url: string) => `href="${url}?${q.toString().replace(/&/g, "&amp;")}"`,
  );
}

export function gateNote(report: GatesReport | null): string {
  if (!report) return "<!-- sat: проверки не запускались -->\n";
  if (report.ok) return "";
  const lines = [
    ...Object.entries(report.checks)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${k}: ${v.detail}`),
    ...report.review.filter((i) => i.severity === "high").map((i) => i.problem),
  ].map((l) => `- ${l.replace(/--/g, "—")}`);
  return `<!-- sat: проверки не пройдены, статья не для публикации как есть\n${lines.join("\n")}\n-->\n`;
}

export function titleOf(meta: string, fallback: string): string {
  return meta.match(/\*\*Заголовок статьи:\*\*\s*(.+)/)?.[1].trim() ?? fallback;
}

/** Блок «## SEO» метаданных (sat-delta). Ключевые слова — через запятую, главный ключ первым. */
export function seoOf(meta: string): { title: string; description: string; keywords: string[] } {
  const block = meta.split(/^## SEO\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const field = (name: string) =>
    block.match(new RegExp(`^\\s*-\\s*\\*\\*${name}:\\*\\*\\s*(.+)$`, "m"))?.[1].trim() ?? "";
  return {
    title: field("Title"),
    description: field("Description"),
    keywords: field("Keywords")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  };
}

/** Ключи Yoast, которые пишет публикация. Тот же набор, что у блога (wiki_visualizer wordpress.sh). */
export const YOAST_KEYS = [
  "_yoast_wpseo_title",
  "_yoast_wpseo_metadesc",
  "_yoast_wpseo_focuskw",
  "_yoast_wpseo_primary_category",
] as const;

export function yoastMeta(
  seo: ReturnType<typeof seoOf>,
  categories: number[],
): Record<string, string> {
  const meta: Record<string, string> = {};
  if (seo.title) meta._yoast_wpseo_title = seo.title;
  if (seo.description) meta._yoast_wpseo_metadesc = seo.description;
  if (seo.keywords[0]) meta._yoast_wpseo_focuskw = seo.keywords[0];
  if (categories[0]) meta._yoast_wpseo_primary_category = String(categories[0]);
  return meta;
}

function withoutPrimary(meta?: Record<string, string>): Record<string, string> | undefined {
  if (!meta) return meta;
  const { _yoast_wpseo_primary_category: _, ...rest } = meta;
  return rest;
}

export type Published = { id: number; link: string; status: string };

/** Пост удалён в WP насовсем: REST отвечает 404 `rest_post_invalid_id` (корзина отдаёт 200 со status trash). */
export function postGone(err: unknown): boolean {
  return (
    err instanceof WpError && err.status === 404 && err.message.includes("rest_post_invalid_id")
  );
}

/**
 * Пост в корзину WP (REST DELETE без force): toolkit/wp этого не умеет. 410 `rest_already_trashed` —
 * уже в корзине, это не ошибка. 404 отдаётся как WpError, его ловит postGone.
 */
export async function trashPost(
  baseUrl: string,
  creds: WpCredentials,
  postId: number,
  doFetch: typeof fetch = fetch,
): Promise<void> {
  const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/wp-json/wp/v2/posts/${postId}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) return;
  const body = await res.text();
  if (res.status === 410 && body.includes("rest_already_trashed")) return;
  throw new WpError(`DELETE posts/${postId}`, res.status, body);
}

type PublishDeps = {
  db: Db;
  cfg: SiteConfig;
  wp: WpClient;
  creds: WpCredentials;
  styleFailures: (dir: string, slug: string) => string[];
  /** Занятые даты сайта (`date_gmt`) для расписания: читаются один раз за прогон, пополняются. */
  busy?: { dates: string[] | null };
  now?: () => Date;
};
type DraftRef = { id: number; candidate_id: number; dir: string; wp_post_id: number | null };

/**
 * Публикация черновика. Пост, который человек удалил в WP, конвейер не пересоздаёт: удаление —
 * решение автора (18.11 spark #9209 — дубль темы #9212, прогон каждый раз падал на updateEntry 404).
 * Тема уходит в rejected с причиной, черновик на диске остаётся.
 */
export async function publishDraft(
  deps: PublishDeps,
  draft: DraftRef,
  slug: string,
): Promise<Published | { blocked: string[] } | { held: string } | { gone: string }> {
  try {
    return await publishOnce(deps, draft, slug);
  } catch (err) {
    if (!draft.wp_post_id || !postGone(err)) throw err;
    const reason = `пост WP ${draft.wp_post_id} удалён вручную, тема снята`;
    deps.db.prepare("UPDATE drafts SET wp_status = 'deleted' WHERE id = ?").run(draft.id);
    deps.db
      .prepare("UPDATE candidates SET status = 'rejected', score_reason = ? WHERE id = ?")
      .run(reason, draft.candidate_id);
    return { gone: reason };
  }
}

async function publishOnce(
  deps: PublishDeps,
  draft: DraftRef,
  slug: string,
): Promise<Published | { blocked: string[] } | { held: string }> {
  const { db, cfg, wp, creds } = deps;
  const blocked = deps.styleFailures(draft.dir, slug);
  if (blocked.length) return { blocked };
  const paths = draftPaths(draft.dir, slug);
  const gatesFile = join(paths.work, "gates.json");
  const report = existsSync(gatesFile)
    ? (JSON.parse(readFileSync(gatesFile, "utf8")) as GatesReport)
    : null;
  // В WP только версия, прошедшая проверки (ADR 0004): провал остаётся на диске, пост в WP —
  // прежний или никакого.
  if (!report?.ok) {
    const failed = report
      ? Object.keys(report.checks).filter((k) => !report.checks[k].ok)
      : ["проверки не запускались"];
    return { held: `проверки не пройдены (${failed.join(", ")}): в WP не уходит` };
  }
  // Уже созданные черновики (ToDo 102) получают новую кнопку при следующей публикации.
  const raw = readFileSync(paths.html, "utf8");
  const meta = readFileSync(paths.meta, "utf8");
  let html = normalizeArticle(raw, leadTermsOf(meta));
  if (html !== raw) writeFileSync(paths.html, html);

  const { preview, schemes } = parseVisuals(meta);
  // Загруженное помним: повторная публикация не плодит копии картинок в медиатеке.
  const mediaFile = join(paths.work, "media.json");
  const uploaded: Record<string, { id: number; url: string }> = existsSync(mediaFile)
    ? JSON.parse(readFileSync(mediaFile, "utf8"))
    : {};
  let featured: number | undefined;
  for (const img of [...schemes, ...(preview ? [preview] : [])]) {
    const file = join(draft.dir, img.file);
    if (!uploaded[img.file]) {
      if (!existsSync(file)) continue; // картинки нет — плейсхолдер остаётся, линтер published это поймает
      const media = await wp.uploadMedia(
        { filePath: file, filename: img.file, altText: img.alt },
        creds,
      );
      uploaded[img.file] = { id: media.id, url: media.sourceUrl };
      writeFileSync(mediaFile, JSON.stringify(uploaded, null, 1));
    }
    html = html.split(`src="TODO_IMAGE/${img.file}"`).join(`src="${uploaded[img.file].url}"`);
    if (preview && img.file === preview.file) featured = uploaded[img.file].id;
  }
  const content = gateNote(report) + withUtm(html, cfg.domain, slug);
  const title = titleOf(meta, slug);
  const seo = seoOf(meta);
  // Без mu-плагина WordPress молча выбрасывает поля Yoast: проверяем схему REST до записи (ToDo 99).
  let seoMeta: Record<string, string> | undefined;
  if (cfg.publish.seoMeta) {
    const keys = new Set(await wp.restMetaKeys());
    const missing = YOAST_KEYS.filter((k) => !keys.has(k));
    if (missing.length)
      throw new Error(
        `publish.seoMeta включён, но REST сайта не принимает ${missing.join(", ")}: нет mu-плагина bds-rest-seo-meta (RUNBOOK §6)`,
      );
    seoMeta = yoastMeta(seo, cfg.publish.categories);
  }
  const tags =
    cfg.publish.tags && seo.keywords.length ? await wp.ensureTags(seo.keywords, creds) : undefined;
  const entry = draft.wp_post_id
    ? await wp.updateEntry(
        draft.wp_post_id,
        // Главная рубрика выбирается только из categories записи, а их обновление не шлёт: без пары
        // Yoast её молча игнорирует (wp/mu-plugins/bds-rest-seo-meta.php). Ставится при создании.
        {
          title,
          contentHtml: content,
          featuredMedia: featured,
          tags,
          meta: withoutPrimary(seoMeta),
        },
        creds,
      )
    : await wp.createEntry(
        {
          title,
          slug,
          contentHtml: content,
          categories: cfg.publish.categories,
          tags,
          featuredMedia: featured,
          status: "draft",
          meta: seoMeta,
        },
        creds,
      );
  const saved = await schedule(deps, entry, report);
  db.prepare("UPDATE drafts SET wp_post_id = ?, wp_url = ?, wp_status = ? WHERE id = ?").run(
    saved.id,
    saved.link,
    saved.status,
    draft.id,
  );
  return saved;
}

/**
 * В расписание идёт только черновик WP, прошедший все проверки. Пост в другом статусе (future,
 * publish, pending, private) не трогаем: его поставил конвейер раньше или человек руками.
 */
async function schedule(
  deps: PublishDeps,
  entry: Published,
  report: GatesReport | null,
): Promise<Published> {
  const { cfg, wp, creds } = deps;
  if (cfg.publish.status !== "future" || !report?.ok || entry.status !== "draft") return entry;
  const now = deps.now?.() ?? new Date();
  const busy = (deps.busy ??= { dates: null });
  busy.dates ??= await wp.entryDates(
    new Date(now.getTime() - 14 * 86400_000).toISOString().slice(0, 19),
    creds,
  );
  const dateGmt = pickSlot(busy.dates, cfg.publish.lane ?? 0, now);
  const out = await wp.publishEntry(entry.id, creds, { dateGmt });
  busy.dates.push(dateGmt);
  return { id: out.id, link: out.link, status: out.status };
}
