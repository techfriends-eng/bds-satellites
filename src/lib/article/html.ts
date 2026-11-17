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
/**
 * Кнопка решения задания (sat-delta п. 5). Тема сайтов ставит summary{display:block} и прячет маркер
 * раскрытия, поэтому значок и подсказка — в самом тексте (ToDo 102, вид выбран автором 17.11).
 * Тот же образец проверяет линтер (профиль sat, solution_summary).
 */
export const SOLUTION_SUMMARY = "<strong>▶ Решение</strong> (нажмите, чтобы открыть)";

/** Любой `<summary>` со словом «Решение» приводится к образцу. Другие `<summary>` не трогаем. */
export function solutionButtons(html: string): string {
  return html.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g, (m, inner: string) =>
    /решение/i.test(inner.replace(/<[^>]+>/g, "")) ? `<summary>${SOLUTION_SUMMARY}</summary>` : m,
  );
}

/**
 * Таблицы (sat-delta п. 3, ToDo 104). Тема спутников ставит ячейкам таблицы без класса
 * text-align:center, а ширину колонок браузер берёт по самому длинному слову: длинное имя
 * параметра раздувает свою колонку, текстовые колонки сжимаются до слога в строке. Поэтому:
 * ширина колонок в шапке — по доле текста, выравнивание влево, в длинных именах точки переноса
 * `<wbr>` после «.», «_», «/» и между частями CamelCase. Стиль инлайном: автор WP без unfiltered_html, kses оставляет
 * width и text-align. Тег `<table>` остаётся без атрибутов: по нему таблицу ищет линтер.
 * Повторный вызов даёт тот же результат: старые стили и `<wbr>` снимаются и считаются заново.
 */
export const LONG_WORD = 16;
const MIN_SHARE = 0.08;

function cellText(inner: string): string {
  return unescapeHtml(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Куски длинного имени между точками переноса: после «.», «_», «/», затем по CamelCase. */
function pieces(word: string): string[] {
  if (word.length < LONG_WORD) return [word];
  return word
    .split(/(?<=[._/])(?=[^\s._/])/)
    .flatMap((p) => (p.length < LONG_WORD ? [p] : p.split(/(?<=[a-z])(?=[A-Z])/)));
}

function breakLong(inner: string): string {
  return inner
    .split(/(<[^>]+>)/)
    .map((seg) => (seg.startsWith("<") ? seg : seg.replace(/\S+/g, (w) => pieces(w).join("<wbr>"))))
    .join("");
}

function longestChunk(text: string): number {
  return Math.max(0, ...text.split(/\s+/).flatMap(pieces).map((w) => w.length));
}

/**
 * Доли ширины колонок в процентах. Цель — одинаковое число строк в ячейках ряда: доля по средней
 * длине текста. Но колонка не уже самого длинного неразрывного куска (из TABLE_CHARS знаков на ряд
 * таблицы, около 750 px темы): такие колонки фиксируются, остаток делится по тексту.
 */
export const TABLE_CHARS = 90;
export function columnShares(rows: string[][]): number[] {
  const n = Math.max(0, ...rows.map((r) => r.length));
  if (!n) return [];
  const cols = Array.from({ length: n }, (_, i) => rows.map((r) => r[i] ?? ""));
  const mean = cols.map((c) => Math.max(1, c.reduce((a, t) => a + t.length, 0) / c.length));
  const floor = cols.map((c) => Math.max(MIN_SHARE, Math.max(0, ...c.map(longestChunk)) / TABLE_CHARS));
  const floorSum = floor.reduce((a, b) => a + b, 0);
  if (floorSum > 0.9) for (let i = 0; i < n; i++) floor[i] *= 0.9 / floorSum;
  const share = new Array<number>(n).fill(0);
  const fixed = new Set<number>();
  for (;;) {
    const free = [...Array(n).keys()].filter((i) => !fixed.has(i));
    const left = 1 - [...fixed].reduce((a, i) => a + share[i], 0);
    const sum = free.reduce((a, i) => a + mean[i], 0);
    for (const i of free) share[i] = (left * mean[i]) / sum;
    const low = free.filter((i) => share[i] < floor[i]);
    if (!low.length || low.length === free.length) break;
    for (const i of low) {
      share[i] = floor[i];
      fixed.add(i);
    }
  }
  const total = share.reduce((a, b) => a + b, 0);
  const pct = share.map((r) => Math.round((r / total) * 100));
  pct[pct.indexOf(Math.max(...pct))] += 100 - pct.reduce((a, b) => a + b, 0);
  return pct;
}

export function tableLayout(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_m, body: string) => {
    const clean = body
      .replace(/<wbr>/g, "")
      .replace(/<(t[hd]|col)\b([^>]*?)\s+style="[^"]*"/g, "<$1$2")
      .replace(/<colgroup>[\s\S]*?<\/colgroup>/g, "");
    const rows = [...clean.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((c) => ({
        attrs: c[2],
        text: cellText(c[3]),
      })),
    );
    const spans = rows.some((r) => r.some((c) => /\bcolspan=/.test(c.attrs)));
    const body0 = rows.slice(/<thead>/.test(clean) ? 1 : 0);
    const shares = spans ? [] : columnShares((body0.length ? body0 : rows).map((r) => r.map((c) => c.text)));
    let row = -1;
    const out = clean.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/g, (tr) => {
      row++;
      let col = -1;
      return tr.replace(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/g, (_c, tag: string, attrs: string, inner: string) => {
        col++;
        const width = row === 0 && shares.length ? `width:${shares[col]}%;` : "";
        return `<${tag}${attrs} style="${width}text-align:left">${breakLong(inner)}</${tag}>`;
      });
    });
    return `<table>${out}</table>`;
  });
}

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
