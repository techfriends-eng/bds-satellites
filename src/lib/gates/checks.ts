import { spawnSync } from "node:child_process";
import { words } from "../dedup/keys.ts";
import type { SiteConfig } from "../config/site.ts";

/** Проверки черновика без LLM. Каждая — { ok, detail }; провал любой — статья не готова. */
export type Check = { ok: boolean; detail: string };

export function stripForText(html: string): string {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
}

/** Оформление — форк линтера блога, профиль sat (lint/sat_lint.py). Отчёт JSON — его провалы. */
export function lint(
  lintPy: string,
  dir: string,
  slug: string,
  domain: string,
  key: string,
): Check & { failed: string[]; style: string[] } {
  const r = spawnSync(
    "python3",
    [lintPy, slug, "--profile", "sat", "--dir", dir, "--domain", domain, "--key", key, "--json"],
    { encoding: "utf8" },
  );
  let report: { failed_items?: string[]; style_failed?: string[]; words?: number };
  try {
    report = JSON.parse(r.stdout);
  } catch {
    return {
      ok: false,
      detail: `линтер не отработал: ${r.stderr.slice(-300)}`,
      failed: ["линтер"],
      style: ["линтер не отработал"], // стиль не проверен — не публикуем
    };
  }
  const failed = report.failed_items ?? [];
  // Провалы стиля — с цитатами: переписыванию нужно видеть, какие именно двоеточия убрать.
  const style = report.style_failed ?? [];
  const other = failed.filter((f) => !style.some((s) => s.startsWith(`${f}:`)));
  return {
    ok: failed.length === 0,
    detail: failed.length ? [...style, ...other].join("; ") : `слов ${report.words}`,
    failed,
    style,
  };
}

const IMAGE = /^\s*image:\s*['"]?([\w./:-]+?)['"]?\s*$/gm;

/** Образ с репозиторием из кэша стенда совпадает с кэшем по тегу: иначе версия устарела. */
export function images(files: Map<string, string>, cfg: SiteConfig): Check {
  const cached = new Map(cfg.stand.images.map((i) => [i.slice(0, i.lastIndexOf(":")), i]));
  const used = new Set<string>();
  for (const body of files.values()) for (const m of body.matchAll(IMAGE)) used.add(m[1]);
  const problems: string[] = [];
  for (const u of used) {
    const repo = u.includes(":") ? u.slice(0, u.lastIndexOf(":")) : u;
    if (!u.includes(":") || u.endsWith(":latest")) problems.push(`${u} без точного тега`);
    else if (cached.has(repo) && cached.get(repo) !== u)
      problems.push(`${u} вместо ${cached.get(repo)}`);
  }
  return {
    ok: problems.length === 0,
    detail: problems.join("; ") || [...used].sort().join(", ") || "образов нет",
  };
}

export type Head = (url: string) => Promise<number>;

/** Исходник есть в статье, внешние ссылки живые. */
// Medium и Cloudflare отвечают роботу 401/403/429 на живую страницу: это не мёртвая ссылка.
const BOT_BLOCK = new Set([401, 403, 429]);

/** Исходник из RSS приходит с utm_* (Хабр) и хвостовыми слэшами; в статье ссылка обычно чистая. */
export function sourceLinked(html: string, sourceUrl: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u.replace(/&amp;/g, "&"));
      for (const k of [...x.searchParams.keys()]) if (/^utm_/i.test(k)) x.searchParams.delete(k);
      x.hash = "";
      return x.toString().replace(/\/+(\?|$)/, "$1");
    } catch {
      return u;
    }
  };
  const want = norm(sourceUrl);
  return [...html.matchAll(/href="([^"]+)"/g)].some((m) => norm(m[1]) === want);
}

/**
 * Что взято из исходника (план, поле source_use). `idea` — только идея: ссылка не нужна (задача 101,
 * решение автора 2026-11-03). `facts` или нет поля (черновики до этого правила) — цифры, цитаты или
 * структура: ссылка обязательна.
 */
export type SourceUse = "idea" | "facts";

export function sourceUse(plan: { source_use?: unknown }): SourceUse {
  return plan.source_use === "idea" ? "idea" : "facts";
}

/**
 * Числа статьи, которые есть в исходнике, но не в документации и не в выводе стенда: значит, цифры
 * взяты из исходника. Годы, однозначные числа и версии (4.3.2) не считаются: они общие и мало что
 * доказывают.
 */
export function sourceNumbers(html: string, source: string, known: string): string[] {
  const nums = (t: string) =>
    new Set(
      [...t.replace(/&nbsp;/g, " ").matchAll(/(?<![\w.])\d+(?:[.,]\d+)?(?:\s?%)?(?![\w.]*\d)/g)]
        .map((m) => m[0].replace(/\s/g, "").replace(",", "."))
        .filter((n) => n.replace(/[^\d]/g, "").length >= 2 && !/^(19|20)\d\d$/.test(n)),
    );
  const outputs = [...html.matchAll(/data-enlighter-language="generic"[^>]*>([\s\S]*?)<\/pre>/g)]
    .map((m) => m[1])
    .join("\n");
  const mine = nums(stripForText(html));
  const theirs = nums(source);
  const ours = nums(`${known}\n${outputs}`);
  return [...mine].filter((n) => theirs.has(n) && !ours.has(n)).sort();
}

export async function links(
  html: string,
  sourceUrl: string,
  domain: string,
  head: Head,
  src: { use?: SourceUse; text?: string; known?: string } = {},
): Promise<Check> {
  const problems: string[] = [];
  const use = src.use ?? "facts";
  if (use === "facts") {
    if (!sourceLinked(html, sourceUrl)) problems.push("нет ссылки на исходник");
  } else if (!sourceLinked(html, sourceUrl)) {
    // Только идея: ссылка не нужна, но цифры исходника в тексте выдают, что взята не только идея.
    const taken = sourceNumbers(html, src.text ?? "", src.known ?? "");
    if (taken.length >= 2)
      problems.push(
        `в плане взята только идея, но в тексте цифры исходника (${taken.slice(0, 5).join(", ")}): нужна ссылка на исходник`,
      );
  }
  const urls = [...new Set([...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]))];
  for (const u of urls.filter((x) => !x.includes(domain))) {
    try {
      const status = await head(u);
      if (status >= 400 && !BOT_BLOCK.has(status)) problems.push(`${u} → ${status}`);
    } catch (err) {
      problems.push(`${u} → ${(err as Error).message.split("\n")[0].slice(0, 60)}`);
    }
  }
  return {
    ok: problems.length === 0,
    detail: problems.join("; ") || `ссылок ${urls.length}, все живые`,
  };
}

export function shingles(text: string, n = 5): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Доля 5-словных шинглов статьи, общих с исходником и своими черновиками. */
export function uniqueness(html: string, others: Record<string, string>, maxShare: number): Check {
  const mine = shingles(stripForText(html));
  if (mine.size === 0) return { ok: false, detail: "пустой текст" };
  const shares = Object.entries(others)
    .map(([name, text]) => {
      const theirs = shingles(text);
      let common = 0;
      for (const s of mine) if (theirs.has(s)) common++;
      return { name, share: common / mine.size };
    })
    .sort((a, b) => b.share - a.share);
  const bad = shares.filter((s) => s.share > maxShare);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.map((s) => `${s.name}: ${pct(s.share)}`).join("; ")
      : shares.length
        ? `максимум ${shares[0].name}: ${pct(shares[0].share)}`
        : "сравнивать не с чем",
  };
}
