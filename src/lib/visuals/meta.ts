/**
 * Визуализации из метаданных статьи (<slug>_meta.md, формат B6 исходника): превью с ALT и промптом,
 * схемы «### Схема N» с файлом, ALT и кодом Mermaid.
 */
export type Scheme = { n: number; file: string; alt: string; mermaid: string };
export type Preview = { file: string; alt: string; prompt: string };

const FILE = /\*\*Имя файла:\*\*\s*`?([\w.-]+)`?/;
const ALT = /\*\*ALT:\*\*\s*(.+)/;

function block(section: string): string {
  const fenced = section.match(/```(?:mermaid|text)?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Отступ в 4 пробела — блок кода markdown (так промпт превью записан в исходном формате B6).
  const indented = section
    .split("\n")
    .filter((l) => l.startsWith("    "))
    .map((l) => l.slice(4));
  return indented.join("\n").trim();
}

function sections(meta: string, heading: RegExp): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  const parts = meta.split(/^(?=#{2,3} )/m);
  for (const p of parts) {
    const m = p.match(heading);
    if (m) out.push({ title: m[0], body: p });
  }
  return out;
}

export function parseVisuals(meta: string): { preview: Preview | null; schemes: Scheme[] } {
  // Терпимо к отклонениям модели от образца: превью под ## или ###, промпт строкой «**Промпт…:**».
  const pv = sections(meta, /^#{2,3} Превью-картинка/)[0];
  const inlinePrompt = pv?.body.match(/\*\*Промпт[^*]*:\*\*\s*(.+)/)?.[1].trim();
  const preview = pv
    ? {
        file: pv.body.match(FILE)?.[1] ?? "",
        alt: pv.body.match(ALT)?.[1].trim() ?? "",
        prompt: block(pv.body.split(ALT)[2] ?? pv.body) || inlinePrompt || "",
      }
    : null;
  const schemes = sections(meta, /^### Схема (\d+)/).map(({ title, body }) => ({
    n: Number(title.replace(/\D+/g, "")),
    file: body.match(FILE)?.[1] ?? "",
    alt: body.match(ALT)?.[1].trim() ?? "",
    mermaid: block(body),
  }));
  return { preview: preview && preview.file ? preview : null, schemes };
}
