/**
 * Правка парами замен «было → стало» (ADR 0002, п. 2): модель шлёт только изменённые места, а не всю
 * статью. Правка — самый дорогой этап (43 % расхода), и почти весь он был выводом статьи целиком.
 *
 * Формат ответа:
 *   =====FIND ARTICLE=====      (или FIND META)
 *   дословный фрагмент
 *   =====REPLACE=====
 *   новый текст (пусто — удалить)
 *
 * Пары применяются по порядку. Фрагмент должен встретиться в файле ровно один раз: не найден или
 * найден несколько раз — пара не применяется, и вся правка уходит на повтор с замечанием.
 */
export type Target = "article" | "meta";
export type Edit = { target: Target; find: string; replace: string };

const MARK = /^=====(FIND ARTICLE|FIND META|REPLACE)=====[ \t]*$/gm;

/** Снимает перевод строки после метки и пробелы в конце блока; отступы в начале строк остаются. */
function body(s: string): string {
  return s.replace(/^\r?\n/, "").replace(/\s+$/, "");
}

export function parseEdits(text: string): Edit[] {
  const marks = [...text.matchAll(MARK)];
  if (!marks.length) throw new Error("в ответе нет пар =====FIND ARTICLE===== / =====REPLACE=====");
  const edits: Edit[] = [];
  for (let i = 0; i < marks.length; i += 2) {
    const find = marks[i];
    const repl = marks[i + 1];
    if (find[1] === "REPLACE" || !repl || repl[1] !== "REPLACE") {
      throw new Error(`пара ${edits.length + 1}: после FIND нужен ровно один REPLACE`);
    }
    const next = marks[i + 2]?.index ?? text.length;
    edits.push({
      target: find[1] === "FIND META" ? "meta" : "article",
      find: body(text.slice(find.index + find[0].length, repl.index)),
      replace: body(text.slice(repl.index + repl[0].length, next)),
    });
  }
  return edits;
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) n++;
  return n;
}

export type Applied = { article: string; meta: string; failed: string[] };

/** Применяет пары по порядку. `failed` — что не применилось и почему, по-русски для замечания модели. */
export function applyEdits(files: { article: string; meta: string }, edits: Edit[]): Applied {
  const out = { ...files };
  const failed: string[] = [];
  edits.forEach((e, i) => {
    const where = e.target === "meta" ? "метаданных" : "статье";
    const head = `пара ${i + 1} (${e.find.slice(0, 80).replace(/\s+/g, " ")}…)`;
    if (!e.find.trim()) {
      failed.push(`${head}: пустой FIND`);
      return;
    }
    const n = count(out[e.target], e.find);
    if (n === 1) out[e.target] = out[e.target].replace(e.find, () => e.replace);
    else if (n === 0) failed.push(`${head}: фрагмента нет в ${where} дословно`);
    else failed.push(`${head}: фрагмент встречается в ${where} ${n} раз, нужен ровно один`);
  });
  if (!edits.length) failed.push("нет ни одной пары замен");
  return { ...out, failed };
}
