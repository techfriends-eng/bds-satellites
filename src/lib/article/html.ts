/**
 * Статья в WP-HTML ↔ файлы прогона. Код — блоки EnlighterJS (Style Guide п. 9), имя файла — первая
 * строка-комментарий кода («# producer.py · …»), место вывода — блок generic со строкой
 * «[[output ИМЯ]]» (style/sat-delta.md). Линтер требует ровно class + data-enlighter-language,
 * поэтому имя файла не может быть атрибутом.
 */
const PRE = /<pre class="EnlighterJSRAW" data-enlighter-language="([a-z]+)">([\s\S]*?)<\/pre>/g;
const OUTPUT = /^\s*\[\[output ([\w./-]+)\]\]\s*$/;
// После вставки вывода место остаётся помеченным комментарием: повторный прогон (правка кода)
// вставляет вывод туда же. Комментарий не виден на странице и выпадает из проверок линтера.
const FILLED =
  /<!-- output ([\w./-]+) -->\n<pre class="EnlighterJSRAW" data-enlighter-language="generic">[\s\S]*?<\/pre>/g;
const FILE_COMMENT = /^\s*(?:#|--|\/\/|<!--)\s*([\w./-]+\.[\w]+|Dockerfile|Makefile)(?=\s|·|$)/;
export const MAX_OUTPUT_LINES = 80;

export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type Parsed = { files: Map<string, string>; outputs: string[] };

/** Имя файла из первой строки-комментария; после shebang `#!` — из второй (run.sh модели так и пишет). */
function fileName(body: string): string | undefined {
  const [first, second = ""] = body.split("\n", 2);
  return (first.startsWith("#!") ? second : first).match(FILE_COMMENT)?.[1];
}

/** Файлы и места вывода по порядку. Повтор имени файла — последний блок. */
export function parseArticle(html: string): Parsed {
  const files = new Map<string, string>();
  const outputs: string[] = [];
  const filled = new Map<number, string>();
  for (const m of html.matchAll(FILLED)) filled.set(m.index + m[0].indexOf("<pre"), m[1]);
  for (const m of html.matchAll(PRE)) {
    const slot = filled.get(m.index);
    if (slot) {
      if (!outputs.includes(slot)) outputs.push(slot);
      continue;
    }
    const body = unescapeHtml(m[2]);
    const out = body.match(OUTPUT);
    if (m[1] === "generic" && out) {
      if (!outputs.includes(out[1])) outputs.push(out[1]);
      continue;
    }
    const name = fileName(body);
    if (name) files.set(name, body.endsWith("\n") ? body : `${body}\n`);
  }
  return { files, outputs };
}

/** Длинный вывод сокращается только целыми строками, с пометкой о пропуске (Style Guide п. 9). */
export function clip(text: string, maxLines = MAX_OUTPUT_LINES): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  const head = Math.floor((maxLines * 2) / 3);
  const tail = Math.floor(maxLines / 3);
  return [
    ...lines.slice(0, head),
    `… (пропущено строк: ${lines.length - head - tail})`,
    ...lines.slice(-tail),
  ].join("\n");
}

/** Вставляет настоящий вывод на место «[[output ИМЯ]]» или в уже помеченное место; вывод экранируется. */
export function setOutputs(html: string, outputs: Record<string, string>): string {
  const block = (name: string) =>
    `<!-- output ${name} -->\n<pre class="EnlighterJSRAW" data-enlighter-language="generic">${escapeHtml(clip(outputs[name]))}</pre>`;
  const refilled = html.replace(FILLED, (whole, name: string) =>
    name in outputs ? block(name) : whole,
  );
  return refilled.replace(PRE, (whole, lang: string, raw: string) => {
    const out = unescapeHtml(raw).match(OUTPUT);
    if (lang !== "generic" || !out || !(out[1] in outputs)) return whole;
    return block(out[1]);
  });
}

/** Вставленный вывод по меткам: после правки текста он возвращается как был, модель его не меняет. */
export function outputsOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(
    /<!-- output ([\w./-]+) -->\n<pre class="EnlighterJSRAW" data-enlighter-language="generic">([\s\S]*?)<\/pre>/g,
  )) {
    out[m[1]] = unescapeHtml(m[2]);
  }
  return out;
}

/** Подменяет код файла (починка после падения прогона): блок с тем же именем в первой строке. */
export function setFile(html: string, name: string, body: string): string {
  return html.replace(PRE, (whole, lang: string, raw: string) => {
    if (fileName(unescapeHtml(raw)) !== name) return whole;
    return `<pre class="EnlighterJSRAW" data-enlighter-language="${lang}">${escapeHtml(body.replace(/\n+$/, ""))}</pre>`;
  });
}

/** Ответ модели «=====ARTICLE===== … =====META===== …» → два файла. */
export function splitAnswer(text: string): { article: string; meta: string } {
  const a = text.indexOf("=====ARTICLE=====");
  const m = text.indexOf("=====META=====");
  if (a < 0 || m < a) throw new Error("в ответе нет разделов =====ARTICLE===== и =====META=====");
  return { article: text.slice(a + 17, m).trim(), meta: text.slice(m + 14).trim() };
}
