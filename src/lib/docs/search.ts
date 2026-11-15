/**
 * Фрагменты официальной документации версий стенда из индекса bds-docs-index (схема docs на supan8n,
 * ADR 0002). План и статья получают текст нужной версии вместо обхода сайтов; смысловая проверка
 * сверяет по нему флаги и API. supan8n недоступен — конвейер идёт без фрагментов, как до индекса.
 *
 * Форк: techfriends-eng/bds-docs-index@2415ba1, src/lib/query.ts
 * Правило запроса (инструкция Qwen3-Embedding) должно совпадать с источником: иначе поиск тихо хуже.
 */
import pg from "pg";

export const QUERY_INSTRUCTION =
  "Given a question about a software product, retrieve documentation passages that answer it";

export function queryText(question: string): string {
  return `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${question.trim()}`;
}

export type DocsProduct = { product: string; version: string };
export type DocsIndexConfig = { products: DocsProduct[]; k: number; maxChars: number };
export type Fragment = {
  product: string;
  version: string;
  section: string;
  url: string;
  content: string;
  similarity: number;
};

export type Embed = (texts: string[]) => Promise<number[][]>;
export type Search = (
  vec: number[],
  text: string,
  p: DocsProduct,
  k: number,
) => Promise<Fragment[]>;

export function ollamaEmbed(
  url: string,
  model = "qwen3-embedding:0.6b",
  f: typeof fetch = fetch,
): Embed {
  return async (texts) => {
    const res = await f(`${url.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts, truncate: true }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const { embeddings } = (await res.json()) as { embeddings?: number[][] };
    if (!embeddings || embeddings.length !== texts.length || embeddings[0]?.length !== 1024) {
      throw new Error("ollama вернула не те вектора");
    }
    return embeddings;
  };
}

export function pgSearch(db: pg.Client): Search {
  return async (vec, text, p, k) => {
    const { rows } = await db.query<{
      product: string;
      version: string;
      heading_path: string[];
      url: string;
      content: string;
      similarity: number;
    }>(
      `select product, version, heading_path, url, content, similarity
         from docs.search($1::vector, $2, $3, $4, $5)`,
      [`[${vec.join(",")}]`, text, p.product, p.version, k],
    );
    return rows.map((r) => ({
      product: r.product,
      version: r.version,
      section: (r.heading_path ?? []).join(" → "),
      url: r.url,
      content: r.content,
      similarity: Number(r.similarity),
    }));
  };
}

/** Запросы из плана: ключ, разделы, что сравниваем. Пустые и дубли отбрасываются. */
export function planQueries(plan: {
  key?: string;
  outline?: string[];
  comparison?: string;
}): string[] {
  const all = [plan.key, ...(plan.outline ?? []).slice(0, 4), plan.comparison]
    .map((q) => (q ?? "").trim())
    .filter((q) => q.length >= 3);
  return [...new Set(all)];
}

/**
 * Фрагменты по всем запросам и продуктам сайта: без повторов (url + раздел), сильнейшие первыми,
 * в пределах maxChars.
 */
export async function gatherFragments(
  queries: string[],
  cfg: DocsIndexConfig,
  embed: Embed,
  search: Search,
): Promise<Fragment[]> {
  if (!queries.length || !cfg.products.length) return [];
  const vecs = await embed(queries.map(queryText));
  const seen = new Map<string, Fragment>();
  for (const [i, q] of queries.entries()) {
    for (const p of cfg.products) {
      for (const f of await search(vecs[i], q, p, cfg.k)) {
        const key = `${f.url}#${f.section}`;
        const prev = seen.get(key);
        if (!prev || prev.similarity < f.similarity) seen.set(key, f);
      }
    }
  }
  const out: Fragment[] = [];
  let size = 0;
  for (const f of [...seen.values()].sort((a, b) => b.similarity - a.similarity)) {
    if (size + f.content.length > cfg.maxChars) continue;
    out.push(f);
    size += f.content.length;
  }
  return out;
}

export function renderFragments(fragments: Fragment[]): string {
  if (!fragments.length) return "";
  return [
    "### Документация версий стенда (индекс bds-docs-index)",
    ...fragments.map(
      (f) =>
        `#### ${f.product} ${f.version} — ${f.section || "без раздела"}\nИсточник: ${f.url}\n${f.content}`,
    ),
  ].join("\n\n");
}

/** Целиком для конвейера: env DOCS_DB_URL и DOCS_OLLAMA_URL; любой сбой — пустая строка и запись в лог. */
export async function docsForPlan(
  plan: { key?: string; outline?: string[]; comparison?: string },
  cfg: DocsIndexConfig | null,
  log: (msg: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dbUrl = env.DOCS_DB_URL?.trim();
  const ollama = env.DOCS_OLLAMA_URL?.trim();
  if (!cfg || !dbUrl || !ollama) return "";
  const db = new pg.Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  try {
    await db.connect();
    const fragments = await gatherFragments(
      planQueries(plan),
      cfg,
      ollamaEmbed(ollama),
      pgSearch(db),
    );
    log(`индекс документации: ${fragments.length} фрагментов`);
    return renderFragments(fragments);
  } catch (err) {
    log(`индекс документации недоступен: ${(err as Error).message}`);
    return "";
  } finally {
    await db.end().catch(() => undefined);
  }
}
