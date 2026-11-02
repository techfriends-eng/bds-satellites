import {
  brandProblems,
  contrast,
  hsl,
  hueDistance,
  isBdsColor,
  MIN_SATURATION,
  type Brand,
  type Hsl,
} from "./brand.ts";

/**
 * Сверка палитры с главной страницей сайта (задача 95): `sat brand-check` и `sat brand-suggest`.
 * Сравнивается оттенок: точного совпадения со стилем сайта не требуем.
 */
export type SiteColor = { hex: string; count: number };
export type BrandCheck = { ok: boolean; problems: string[]; site: SiteColor[] };

const HUE_TOLERANCE = 30;
/** Тема WordPress повторяет #232C3D и #E3E9EE на всех сайтах: тёмное и бледное оттенком не считаем. */
const MIN_LIGHTNESS = 0.25;
const MAX_LIGHTNESS = 0.9;
/** Единичный цвет на странице — чужой виджет, а не стиль сайта. */
const MIN_SHARE = 0.1;
const MAX_STYLESHEETS = 5;
const WP_PRESET = /--wp--preset--color--[\w-]+\s*:\s*#[0-9a-f]{3,8}/gi;

function isChromatic(c: Hsl): boolean {
  return c.s >= MIN_SATURATION && c.l >= MIN_LIGHTNESS && c.l <= MAX_LIGHTNESS;
}

/** Хроматические цвета страницы, самые частые первыми. */
export function siteColors(css: string): SiteColor[] {
  const counts = new Map<string, number>();
  for (const [hex] of css.replace(WP_PRESET, "").matchAll(/#[0-9a-f]{6}\b/gi)) {
    const key = hex.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts]
    .map(([hex, count]) => ({ hex, count }))
    .filter((c) => isChromatic(hsl(c.hex)))
    .sort((a, b) => b.count - a.count);
  const floor = (colors[0]?.count ?? 0) * MIN_SHARE;
  return colors.filter((c) => c.count >= floor);
}

/** Цвета главной страницы. Если в разметке их нет, читаются таблицы стилей того же домена. */
export async function fetchSiteColors(
  domain: string,
  doFetch: typeof fetch = fetch,
): Promise<SiteColor[]> {
  const get = async (url: string) => {
    const res = await doFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
  };
  const home = `https://${domain}/`;
  const html = await get(home);
  const inline = siteColors(html);
  if (inline.length) return inline;
  const links = [...html.matchAll(/<link[^>]+stylesheet[^>]+href=["']([^"']+)["']/gi)]
    .map((m) => new URL(m[1], home))
    .filter((u) => u.hostname === domain)
    .slice(0, MAX_STYLESHEETS);
  const sheets = await Promise.all(links.map((u) => get(u.href).catch(() => "")));
  return siteColors(sheets.join("\n"));
}

/** Каждый цвет brand с оттенком близок цвету сайта, и хотя бы один такой есть. Графит оттенка не имеет. */
export function checkBrand(brand: Brand, site: SiteColor[]): BrandCheck {
  const problems = brandProblems(brand);
  if (!site.length) {
    problems.push("на главной не найдено цветов с оттенком, сверить не с чем");
    return { ok: false, problems, site };
  }
  const hues = site.map((c) => hsl(c.hex).h);
  const own = (["primary", "accent"] as const).filter((k) => hsl(brand[k]).s >= MIN_SATURATION);
  if (!own.length) problems.push("primary и accent без оттенка, со стилем сайта не связаны");
  for (const key of own) {
    const h = hsl(brand[key]).h;
    if (!hues.some((s) => hueDistance(h, s) <= HUE_TOLERANCE)) {
      problems.push(`${key} ${brand[key]}: оттенок далёк от цветов главной`);
    }
  }
  return { ok: problems.length === 0, problems, site };
}

function hex({ h, s, l }: Hsl): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/** Главный цвет: темнее цвета сайта, пока белый текст на нём не наберёт контраст и не уйдёт от BDS. */
function darkEnough(c: Hsl): Hsl {
  let l = c.l;
  while (l > 0.1 && contrast("#FFFFFF", hex({ ...c, l })) < 5) l -= 0.01;
  return { ...c, l };
}

/** Палитра для нового сайта из цветов главной. Null: цветов нет, палитру задаёт автор. */
export function suggestBrand(site: SiteColor[]): Brand | null {
  if (!site.length) return null;
  const [main, second] = site.map((c) => hsl(c.hex));
  for (const shift of [0, 20, -20, 40, -40]) {
    const h = (main.h + shift + 360) % 360;
    const primary = hex(darkEnough({ ...main, h }));
    const brand: Brand = {
      primary,
      accent:
        shift === 0 && second
          ? hex(second)
          : shift === 0 && primary !== hex(main)
            ? hex(main)
            : hex({ h, s: main.s, l: 0.75 }),
      background: hex({ h, s: 0.3, l: 0.97 }),
      text: hex({ h, s: 0.3, l: 0.15 }),
    };
    if (!isBdsColor(primary) && brandProblems(brand).length === 0) return brand;
  }
  return null;
}

export function brandYaml(b: Brand): string {
  return `brand: { primary: "${b.primary}", accent: "${b.accent}", background: "${b.background}", text: "${b.text}" }`;
}
