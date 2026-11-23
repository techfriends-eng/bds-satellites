import { LANES } from "../publish/slot.ts";
import { readFileSync } from "node:fs";
import { CLI_DEFAULTS, type CliOptions } from "../llm/claude-cli.ts";
import { parseModel } from "../llm/client.ts";
import { homedir } from "node:os";
import { parse } from "yaml";
import { parseBrand, type Brand } from "../brand/brand.ts";
import { weekStart } from "../schedule.ts";

/** Конфиг сайта-спутника: `config/site.yaml` в репо сайта (bds-sat-<site>). */

export const SOURCE_KINDS = ["blog", "release", "aggregator", "youtube"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type Source = { id: string; kind: SourceKind; title: string; url: string; topical: boolean };
export type Course = { title: string; path: string };
/** Раздел официальной документации: версия задана адресом, pages — проверенные пути от base. */
export type DocSource = { title: string; base: string; pages: string[] };
export type DocsIndex = {
  products: { product: string; version: string }[];
  k: number;
  maxChars: number;
};

export type SiteConfig = {
  siteId: string;
  domain: string;
  brand: Brand;
  topics: string[];
  courses: Course[];
  sources: Source[];
  docs: DocSource[];
  /** Индекс bds-docs-index (ADR 0002): продукты и версии стенда; null — не используется. */
  docsIndex: DocsIndex | null;
  collect: { timeoutMs: number; simhashMaxDistance: number; simhashMinWords: number };
  select: {
    maxAgeDays: number;
    keywords: string[];
    perRun: number;
    minRelevance: number;
    minDepth: number;
    maxFetches: number;
  };
  llm: {
    /** Список моделей этапа с откатом по порядку (ADR 0002); в YAML можно строкой — список из одной. */
    models: Record<
      "select" | "plan" | "write" | "fix" | "review" | "revise" | "align" | "image" | "video",
      string[]
    >;
    reasoning: Partial<Record<string, Record<string, unknown>>>;
    maxCostPerRunUsd: number;
    /** Потолок недели сайта для тактов (ADR 0002 §3); по умолчанию равен потолку прогона. */
    maxCostPerWeekUsd: number;
    /** Пороги подписки для `claude-cli:` (claude-cli.ts). */
    claudeCli: CliOptions;
    /**
     * A/B моделей черновика (ADR 0002 п. 2): тема получает вариант на первом вызове этапа из `stages`
     * и держит его до конца; у варианта свой список моделей с откатом. Нет секции — A/B выключен.
     */
    ab?: { stages: string[]; variants: Record<string, string[]> };
  };
  stand: { base: string; maxFixes: number; images: string[]; memoryLimitMb: number; pyRun: string };
  gates: {
    minWords: number;
    maxWords: number;
    maxShingleShare: number;
    maxRevisions: number;
    maxRevisionsTotal: number;
  };
  /**
   * tags — метки WP из Keywords метаданных. seoMeta — поля Yoast через REST: включать только после
   * установки mu-плагина wp/mu-plugins/bds-rest-seo-meta.php (RUNBOOK сайта), иначе публикация
   * остановится с ошибкой, а не запишет SEO мимо.
   */
  publish: {
    /** draft — только черновик; future — прошедшая проверки статья встаёт в расписание (ToDo 98). */
    status: "draft" | "future";
    /** Полоса минут сайта в расписании (publish/slot.ts), у каждого спутника своя. */
    lane: number | null;
    categories: number[];
    tags: boolean;
    seoMeta: boolean;
  };
  schedule: { day: string };
  bdsBase: string;
};

/** Пересказ видео YouTube по ссылке: OpenRouter передаёт её Gemini в Google AI Studio. */
export const DEFAULT_VIDEO_MODELS = ["google/gemini-2.5-flash"];

const YOUTUBE_FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=";

type Raw = Record<string, unknown> & {
  site?: { id?: string; domain?: string };
  sources?: Record<string, unknown>[];
};

function section<T>(raw: Raw, key: string, defaults: T): T {
  return { ...defaults, ...((raw[key] as Partial<T> | undefined) ?? {}) };
}

/** `~` в путях конфига раскрывается в дом пользователя сайта, который запускает конвейер. */
export function expandHome(path: string, home = homedir()): string {
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

function parseDocs(raw: Raw): DocSource[] {
  return ((raw.docs as Partial<DocSource>[] | undefined) ?? []).map((d) => {
    const base = String(d.base);
    if (!d.title || !/^https?:\/\/[^/]+\/(.*\/)?$/.test(base))
      throw new Error(`docs: нужны title и base с «/» на конце (${base})`);
    return { title: d.title, base, pages: d.pages ?? [] };
  });
}

function parseDocsIndex(raw: Raw): DocsIndex | null {
  const d = raw.docs_index as
    | { products?: { product?: unknown; version?: unknown }[]; k?: number; max_chars?: number }
    | undefined;
  if (!d) return null;
  const products = (d.products ?? []).map((p, i) => {
    if (!p.product || !p.version)
      throw new Error(`docs_index.products[${i}]: нужны product и version`);
    return { product: String(p.product), version: String(p.version) };
  });
  if (!products.length) throw new Error("docs_index.products пуст");
  return { products, k: Number(d.k ?? 4), maxChars: Number(d.max_chars ?? 12_000) };
}

function parseSchedule(raw: Raw): SiteConfig["schedule"] {
  const schedule = section(raw, "schedule", { day: "mon" });
  weekStart(schedule.day); // неизвестный день — ошибка разбора, а не тихий сдвиг недели
  return schedule;
}

function parseLlm(raw: Raw): SiteConfig["llm"] {
  const llm = section(raw, "llm", {
    models: {} as Record<string, unknown>,
    reasoning: {},
    maxCostPerRunUsd: 2,
    maxCostPerWeekUsd: undefined as number | undefined,
    claudeCli: {} as Partial<CliOptions>,
  });
  const models: Record<string, string[]> = {};
  for (const [stage, v] of Object.entries(llm.models ?? {})) {
    const list = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
    if (!list.length) throw new Error(`llm.models.${stage}: пустой список`);
    for (const m of list) {
      const spec = parseModel(m);
      if ((stage === "image" || stage === "video") && spec.provider !== "openrouter")
        throw new Error(`llm.models.${stage}: только OpenRouter (${m})`);
    }
    models[stage] = list;
  }
  // align (ADR 0003) без своей строки в конфиге идёт той же парой моделей и тем же effort, что revise.
  if (!models.align && models.revise) models.align = models.revise;
  // Видео YouTube читает Gemini по ссылке: сам YouTube серверам в AWS субтитров не отдаёт (бот-проверка).
  if (!models.video) models.video = [...DEFAULT_VIDEO_MODELS];
  const reasoning: Partial<Record<string, Record<string, unknown>>> = { ...llm.reasoning };
  if (!reasoning.align && reasoning.revise) reasoning.align = reasoning.revise;
  return {
    models: models as SiteConfig["llm"]["models"],
    reasoning,
    maxCostPerRunUsd: llm.maxCostPerRunUsd,
    maxCostPerWeekUsd: Number(llm.maxCostPerWeekUsd ?? llm.maxCostPerRunUsd),
    claudeCli: { ...CLI_DEFAULTS, ...llm.claudeCli },
    ...(raw.llm && (raw.llm as Raw).ab ? { ab: parseAb((raw.llm as Raw).ab as Raw) } : {}),
  };
}

const AB_STAGES = ["plan", "write", "fix"];

function parseAb(ab: Raw): NonNullable<SiteConfig["llm"]["ab"]> {
  const stages = ((ab.stages as unknown[]) ?? AB_STAGES).map(String);
  for (const s of stages)
    if (!AB_STAGES.includes(s))
      throw new Error(`llm.ab.stages: ${s}, можно ${AB_STAGES.join(", ")}`);
  const variants: Record<string, string[]> = {};
  for (const [name, v] of Object.entries((ab.variants as Raw) ?? {})) {
    const list = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
    if (!list.length) throw new Error(`llm.ab.variants.${name}: пустой список`);
    list.forEach((m) => parseModel(m));
    variants[name] = list;
  }
  if (Object.keys(variants).length < 2)
    throw new Error("llm.ab.variants: нужно два варианта или больше");
  return { stages, variants };
}

export function parseSiteConfig(text: string): SiteConfig {
  const raw = (parse(text) ?? {}) as Raw;
  if (!raw.site?.id || !raw.site.domain) throw new Error("site.id и site.domain обязательны");
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const s of raw.sources ?? []) {
    const id = String(s.id);
    if (s.enabled === false) continue;
    if (!SOURCE_KINDS.includes(s.kind as SourceKind))
      throw new Error(`источник ${id}: kind ${s.kind}`);
    if (seen.has(id)) throw new Error(`источник ${id} повторяется`);
    seen.add(id);
    const url = s.kind === "youtube" ? `${YOUTUBE_FEED}${s.channel_id}` : String(s.url);
    sources.push({
      id,
      kind: s.kind as SourceKind,
      title: String(s.title ?? id),
      url,
      topical: s.topical === true,
    });
  }
  const select = section(raw, "select", {
    maxAgeDays: 365,
    keywords: [] as string[],
    perRun: 2,
    minRelevance: 7,
    minDepth: 6,
    maxFetches: 4,
  });
  // Пустой список ключей пропустил бы весь пул: это ошибка конфига, а не «без фильтра».
  if (select.keywords.length === 0) throw new Error("select.keywords пуст");
  const publish = section(raw, "publish", {
    status: "draft" as "draft" | "future",
    lane: null as number | null,
    categories: [] as number[],
    tags: true,
    seoMeta: false,
  });
  if (publish.status !== "draft" && publish.status !== "future")
    throw new Error(`publish.status: ${publish.status}, нужен draft или future`);
  if (
    publish.status === "future" &&
    !(Number.isInteger(publish.lane) && publish.lane! >= 0 && publish.lane! < LANES)
  )
    throw new Error(`publish.lane: при status future нужен 0..${LANES - 1}, у каждого сайта свой`);
  return {
    siteId: raw.site.id,
    domain: raw.site.domain,
    brand: parseBrand(raw.brand),
    topics: (raw.topics as string[] | undefined) ?? [],
    courses: (raw.courses as Course[] | undefined) ?? [],
    sources,
    docs: parseDocs(raw),
    docsIndex: parseDocsIndex(raw),
    collect: section(raw, "collect", {
      timeoutMs: 20_000,
      simhashMaxDistance: 6,
      simhashMinWords: 20,
    }),
    select,
    llm: parseLlm(raw),
    stand: section(raw, "stand", {
      base: "/var/lib/bds-sat/runs",
      maxFixes: 2,
      images: [] as string[],
      memoryLimitMb: 6144,
      pyRun: "",
    }),
    gates: section(raw, "gates", {
      minWords: 1200,
      maxWords: 2600,
      maxShingleShare: 0.15,
      maxRevisions: 2,
      maxRevisionsTotal: 4,
    }),
    publish,
    schedule: parseSchedule(raw),
    bdsBase: String(
      (raw.bds as { base?: string } | undefined)?.base ?? "https://bigdataschool.ru",
    ).replace(/\/+$/, ""),
  };
}

export function loadSiteConfig(path: string): SiteConfig {
  return parseSiteConfig(readFileSync(path, "utf8"));
}
