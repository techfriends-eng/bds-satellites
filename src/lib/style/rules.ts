import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Правила текста — форк bds-article (style/upstream) плюс отличия спутников (style/sat-delta.md).
 * Из article-write берутся Style Guide V10-Blog и визуализации B5: процедура стадии и формат брифа
 * блога спутнику не нужны.
 */
export type Style = { styleGuide: string; satDelta: string };

export function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`в правилах нет раздела «${from}» … «${to}»`);
  return text.slice(start, end).trim();
}

/**
 * Палитра в правилах из форка — цвета bigdataschool.ru. Копия в upstream не правится, поэтому модель
 * просто её не видит: цвета схем и превью задаёт конвейер из brand сайта (sat-delta).
 */
function withoutBdsPalette(guide: string): string {
  const scheme = /В начале каждой схемы стоит init-блок[\s\S]*?classDef accent[^\n]*\n/;
  if (!scheme.test(guide) || !guide.includes("- палитру из K5;\n")) {
    throw new Error("в правилах B5 не найдена палитра BDS: проверьте новую копию style/upstream");
  }
  return guide
    .replace(scheme, "Цвета схемы задаёт конвейер, см. отличия спутников.\n")
    .replace("- палитру из K5;\n", "");
}

export function loadStyle(styleDir: string): Style {
  const write = readFileSync(join(styleDir, "upstream", "article-write.rules.md"), "utf8");
  return {
    styleGuide: withoutBdsPalette(section(write, "## STYLE GUIDE V10-Blog", "## B6.")),
    satDelta: readFileSync(join(styleDir, "sat-delta.md"), "utf8").trim(),
  };
}
