import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WpClient, WpCredentials } from "@techfriends-eng/toolkit/wp";
import type { SiteConfig } from "../config/site.ts";
import type { GatesReport } from "../gates/run.ts";
import { draftPaths } from "../generate/draft.ts";
import type { Db } from "../store/db.ts";
import { parseVisuals } from "../visuals/meta.ts";

/**
 * Черновик в WordPress сайта через toolkit/wp. Пока статус всегда draft (publish.status).
 * Картинки (схемы и превью) — в медиатеку, TODO_IMAGE заменяется адресом. Ссылки на курсы
 * получают UTM. Не прошедшая проверки статья тоже уходит черновиком, причины — комментарием в начале.
 * Повторная публикация обновляет тот же пост (drafts.wp_post_id).
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

export async function publishDraft(
  deps: { db: Db; cfg: SiteConfig; wp: WpClient; creds: WpCredentials },
  draft: { id: number; candidate_id: number; dir: string; wp_post_id: number | null },
  slug: string,
): Promise<{ id: number; link: string; status: string }> {
  const { db, cfg, wp, creds } = deps;
  const paths = draftPaths(draft.dir, slug);
  let html = readFileSync(paths.html, "utf8");
  const meta = readFileSync(paths.meta, "utf8");
  const gatesFile = join(paths.work, "gates.json");
  const report = existsSync(gatesFile)
    ? (JSON.parse(readFileSync(gatesFile, "utf8")) as GatesReport)
    : null;

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
  const entry = draft.wp_post_id
    ? await wp.updateEntry(draft.wp_post_id, { title, contentHtml: content }, creds)
    : await wp.createEntry(
        {
          title,
          slug,
          contentHtml: content,
          categories: cfg.publish.categories,
          featuredMedia: featured,
          status: cfg.publish.status,
        },
        creds,
      );
  db.prepare("UPDATE drafts SET wp_post_id = ?, wp_url = ?, wp_status = ? WHERE id = ?").run(
    entry.id,
    entry.link,
    entry.status,
    draft.id,
  );
  return entry;
}
