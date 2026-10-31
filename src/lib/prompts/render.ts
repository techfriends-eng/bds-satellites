import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SiteConfig } from "../config/site.ts";

/**
 * Промпты — prompts/<имя>.md общего пакета, блоки «## system» и «## user», подстановка {поле}.
 * Сайт дополняет системную часть файлом prompts/site/<имя>.md своего репо (ADR 0001): общий текст
 * не копируется в сайты, а расширяется.
 */
export function render(
  dir: string | string[],
  name: string,
  cfg: SiteConfig,
  fields: Record<string, string>,
): { system: string; user: string } {
  const [base, ...extra] = Array.isArray(dir) ? dir : [dir];
  const text = readFileSync(join(base, `${name}.md`), "utf8");
  const sys = text.indexOf("## system\n");
  const usr = text.indexOf("## user\n");
  if (sys < 0 || usr < sys) throw new Error(`промпт ${name}: нужны блоки «## system» и «## user»`);
  let system = text.slice(sys + 10, usr).trim();
  for (const d of extra) {
    const site = join(d, `${name}.md`);
    if (existsSync(site)) system += `\n\n${readFileSync(site, "utf8").trim()}`;
  }
  const values: Record<string, string> = {
    domain: cfg.domain,
    topics: cfg.topics.map((t) => `- ${t}`).join("\n"),
    courses: cfg.courses.map((c) => `- ${c.title} — https://${cfg.domain}${c.path}`).join("\n"),
    images: cfg.stand.images.join(", ") || "нет",
    ...fields,
  };
  // Один проход по шаблону: {{ и }} — буквальные скобки, {поле} — подстановка. Значения уже не
  // разбираются, поэтому JSON в данных (вложенные }}) не портится.
  const fill = (s: string) =>
    s.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, key?: string) =>
      key === undefined ? m[0] : key in values ? values[key] : m,
    );
  return { system: fill(system), user: fill(text.slice(usr + 8).trim()) };
}
