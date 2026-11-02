/**
 * Палитра сайта-спутника: блок brand в config/site.yaml (задача 94). Цвета в схемах и превью задаёт
 * конвейер, а не модель: цвета, которые написала модель, отбрасываются. Палитра bigdataschool.ru запрещена.
 */
export type Brand = { primary: string; accent: string; background: string; text: string };

export const BDS_PALETTE = ["#294A70", "#FFAB1F", "#F5F7FA"];

const WHITE = "#FFFFFF";
const HEX = /^#[0-9a-f]{6}$/i;
const MIN_TEXT_CONTRAST = 4.5;
const MIN_LINE_CONTRAST = 3;
/** Ниже этой насыщенности оттенка у цвета нет: графит и серый не спорят с синим BDS. */
export const MIN_SATURATION = 0.15;
const BDS_HUE_DEGREES = 15;
const BDS_LIGHTNESS = 0.25;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст WCAG 2.1. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export type Hsl = { h: number; s: number; l: number };

export function hsl(hex: string): Hsl {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Цвет того же оттенка и близкой светлоты, что и цвет BDS, читается как цвет bigdataschool.ru. */
export function isBdsColor(hex: string): boolean {
  const upper = hex.toUpperCase();
  if (BDS_PALETTE.includes(upper)) return true;
  const c = hsl(hex);
  if (c.s < MIN_SATURATION) return false;
  return BDS_PALETTE.slice(0, 2).some((b) => {
    const bds = hsl(b);
    return hueDistance(c.h, bds.h) < BDS_HUE_DEGREES && Math.abs(c.l - bds.l) < BDS_LIGHTNESS;
  });
}

/** Текст на цвете: белый или цвет текста сайта, что контрастнее. */
export function textOn(fill: string, brand: Brand): string {
  return contrast(WHITE, fill) >= contrast(brand.text, fill) ? WHITE : brand.text;
}

/** Что не так с палитрой; пустой список, если она годится. */
export function brandProblems(b: Brand): string[] {
  const out: string[] = [];
  for (const key of ["primary", "accent", "background"] as const) {
    if (isBdsColor(b[key])) out.push(`${key} ${b[key]}: цвет палитры bigdataschool.ru`);
  }
  for (const key of ["primary", "accent"] as const) {
    const c = contrast(textOn(b[key], b), b[key]);
    if (c < MIN_TEXT_CONTRAST) out.push(`${key} ${b[key]}: контраст текста ${c.toFixed(2)}`);
  }
  const text = contrast(b.text, b.background);
  if (text < MIN_TEXT_CONTRAST) out.push(`text на background: контраст ${text.toFixed(2)}`);
  const line = contrast(b.primary, b.background);
  if (line < MIN_LINE_CONTRAST) out.push(`primary на background: контраст ${line.toFixed(2)}`);
  return out;
}

export function parseBrand(raw: unknown): Brand {
  const hint = "заполните блок brand в config/site.yaml, предложение даёт sat brand-suggest";
  if (!raw || typeof raw !== "object") throw new Error(`brand обязателен: ${hint}`);
  const r = raw as Record<string, unknown>;
  for (const key of ["primary", "accent", "background", "text"]) {
    if (typeof r[key] !== "string" || !HEX.test(r[key]))
      throw new Error(`brand.${key}: нужен цвет #RRGGBB (${String(r[key])}); ${hint}`);
  }
  const brand = r as unknown as Brand;
  const problems = brandProblems(brand);
  if (problems.length) throw new Error(`brand: ${problems.join("; ")}`);
  return brand;
}

/** Параметры mmdc: база форка (шрифт, отступы) плюс цвета сайта. Подписи дуг читаются на фоне. */
export function mermaidConfig(base: Record<string, unknown>, b: Brand): Record<string, unknown> {
  return {
    ...base,
    theme: "base",
    themeVariables: {
      ...(base.themeVariables as Record<string, unknown> | undefined),
      background: b.background,
      fontFamily: "Arial",
      primaryColor: b.primary,
      primaryTextColor: textOn(b.primary, b),
      primaryBorderColor: b.primary,
      secondaryColor: b.accent,
      secondaryTextColor: textOn(b.accent, b),
      secondaryBorderColor: b.primary,
      tertiaryColor: b.background,
      tertiaryTextColor: b.text,
      tertiaryBorderColor: b.primary,
      lineColor: b.primary,
      textColor: b.text,
      edgeLabelBackground: b.background,
      noteBkgColor: b.background,
      noteTextColor: b.text,
      noteBorderColor: b.primary,
    },
    themeCSS: `.edgeLabel, .edgeLabel * { color: ${b.text} !important; fill: ${b.text} !important; }`,
  };
}

function rgbCss(hex: string): string {
  return `rgb(${rgb(hex).join(",")})`;
}

const CSS_COLOR = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/i;

/**
 * Код схемы без цветов модели: init и frontmatter убраны, style и linkStyle с цветом убраны, любой
 * classDef становится акцентом сайта (выделение узла сохраняется, его цвет нет), фон rect и box из brand.
 */
export function brandMermaid(code: string, b: Brand): string {
  const accent = `fill:${b.accent},stroke:${b.primary},color:${textOn(b.accent, b)}`;
  const body = code
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*(\n|$)/, "")
    .replace(/%%\{\s*init(ialize)?\b[\s\S]*?\}%%[ \t]*\n?/g, "");
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*(style|linkStyle)\b.*:/.test(line)) continue;
    const def = /^(\s*)classDef\s+(\S+)/.exec(line);
    if (def) {
      if (def[2] !== "default") lines.push(`${def[1]}classDef ${def[2]} ${accent};`);
      continue;
    }
    const area = /^(\s*)(rect|box)\s+(.*)$/.exec(line);
    if (area && CSS_COLOR.test(area[3])) {
      const rest = area[3].replace(CSS_COLOR, "").trim();
      lines.push(
        area[2] === "rect"
          ? `${area[1]}rect ${rgbCss(b.background)}`
          : `${area[1]}box ${rest}`.trimEnd(),
      );
      continue;
    }
    lines.push(line);
  }
  const text = lines.join("\n").trim();
  const head = text.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) ?? "";
  const hasAccent = /^\s*classDef\s+(\S+,)?accent\b/m.test(text);
  return /^\s*(flowchart|graph|stateDiagram)/.test(head) && !hasAccent
    ? `${text}\n  classDef accent ${accent};`
    : text;
}

/** Промпт превью: цвета модели убраны, палитра сайта дописана. */
export function brandPreviewPrompt(prompt: string, b: Brand): string {
  const clean = prompt
    .replace(
      /(?:(?:colou?r\s+)?palette|colou?rs?)?[\s:]*#[0-9a-f]{6}\b(?:[\s,and]*#[0-9a-f]{6}\b)*/gi,
      "",
    )
    .replace(/\s+([.,;])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
  return `${clean}\n\nColor palette: main ${b.primary}, accent ${b.accent}, light background ${b.background}. Use no other strong colors.`;
}
