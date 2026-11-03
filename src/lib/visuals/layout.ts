/**
 * Направление схемы (ToDo 103, правило автора 2026-11-03). По умолчанию схема горизонтальная.
 * Вертикальная допустима в двух случаях: сравнение двух решений, каждое в своей колонке (два и больше
 * subgraph), или в каждом ряду не меньше 3 блоков. Замер 18 схем на progon 2026-11-03: все LR и TB с
 * широкими рядами дали h/w 0.15–0.69, две вертикальные цепочки TD — 2.23 и 5.30 (ширина 358 и 151 px).
 */

export type Layout = {
  kind: "flowchart" | "state" | "other";
  vertical: boolean;
  /** Блоков на каждом уровне сверху вниз (длиннейший путь от корней). */
  levels: number[];
  subgraphs: number;
};

const SKIP =
  /^(%%|classDef\b|class\b|style\b|linkStyle\b|click\b|end\b|direction\b|note\b|accTitle|accDescr)/;
// Связь: -->, ---, ==>, -.->, <-->, --o, --x, с подписью |…| или «-- текст -->».
const EDGE =
  /\s*(?:<?--\s+[^->|]+?\s+--[->ox]|<?==\s+[^=>|]+?\s+==[=>]|<?-\.[^.]*?\.->|<?-{2,}[->ox]?|<?={2,}[=>]?|<?-\.+->?|~~~)\s*(?:\|[^|]*\|)?\s*/;

function nodeIds(segment: string): string[] {
  return segment
    .split(/\s*&\s*/)
    .map((s) => s.trim().match(/^(\[\*\]|[\p{L}\w][\p{L}\w.-]*)/u)?.[1] ?? "")
    .filter(Boolean);
}

export function layout(mermaid: string): Layout {
  const code = mermaid.replace(/%%\{[\s\S]*?\}%%/g, "");
  const lines = code
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines[0] ?? "";
  const kind = /^(flowchart|graph)\b/.test(head)
    ? "flowchart"
    : /^stateDiagram/.test(head)
      ? "state"
      : "other";
  if (kind === "other") return { kind, vertical: false, levels: [], subgraphs: 0 };
  // Без направления flowchart и stateDiagram рисуются сверху вниз.
  let dir = kind === "flowchart" ? (head.split(/\s+/)[1] ?? "TB") : "TB";
  const top = lines.slice(1).find((l) => /^direction\s+/.test(l));
  if (kind === "state" && top) dir = top.split(/\s+/)[1];
  const vertical = /^(TB|TD|BT)$/i.test(dir);

  const out = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  let subgraphs = 0;
  for (const line of lines.slice(1)) {
    if (/^subgraph\b/.test(line) || /^state\s+\S+\s*\{/.test(line)) {
      subgraphs++;
      continue;
    }
    if (SKIP.test(line) || line === "}") continue;
    const parts = line.split(EDGE).map(nodeIds);
    for (const ids of parts) for (const id of ids) nodes.add(id);
    for (let i = 0; i + 1 < parts.length; i++)
      for (const a of parts[i])
        for (const b of parts[i + 1]) {
          if (a === b) continue;
          if (!out.has(a)) out.set(a, new Set());
          out.get(a)!.add(b);
        }
  }
  // Уровень узла — длиннейший путь от корня; циклы не удлиняют путь (узел на стеке пропускается).
  const level = new Map<string, number>();
  const depth = (n: string, stack: Set<string>): number => {
    if (level.has(n)) return level.get(n)!;
    stack.add(n);
    let d = 0;
    for (const [a, bs] of out) if (bs.has(n) && !stack.has(a)) d = Math.max(d, depth(a, stack) + 1);
    stack.delete(n);
    level.set(n, d);
    return d;
  };
  for (const n of nodes) depth(n, new Set());
  const levels: number[] = [];
  for (const d of level.values()) levels[d] = (levels[d] ?? 0) + 1;
  return { kind, vertical, levels: [...levels].map((x) => x ?? 0), subgraphs };
}

/** null — схема в порядке, иначе что не так и как исправить. */
export function verticalProblem(mermaid: string): string | null {
  const l = layout(mermaid);
  if (!l.vertical) return null;
  if (l.subgraphs >= 2) return null;
  if (l.levels.length > 0 && l.levels.every((n) => n >= 3)) return null;
  return `вертикальная схема, уровней ${l.levels.length}, блоков по уровням ${l.levels.join("/")}; нужна flowchart LR, длинную цепочку раздели на две схемы`;
}

/** Высота к ширине у JPEG по маркеру SOF, без декодирования. */
export function jpegRatio(bytes: Uint8Array): number | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const m = bytes[i + 1];
    if (m >= 0xc0 && m <= 0xc3) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      return w ? h / w : null;
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

/** Порог по замеру выше: 0.69 у широкой TB, 2.23 у вертикальной цепочки. */
export const MAX_RATIO = 1;
