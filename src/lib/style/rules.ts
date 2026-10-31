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

export function loadStyle(styleDir: string): Style {
  const write = readFileSync(join(styleDir, "upstream", "article-write.rules.md"), "utf8");
  return {
    styleGuide: section(write, "## STYLE GUIDE V10-Blog", "## B6."),
    satDelta: readFileSync(join(styleDir, "sat-delta.md"), "utf8").trim(),
  };
}
