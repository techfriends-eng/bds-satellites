import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse } from "yaml";

/** Конфиг сайта-спутника: `config/site.yaml` в репо сайта (bds-sat-<site>). */

export const SOURCE_KINDS = ["blog", "release", "aggregator", "youtube"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type Source = { id: string; kind: SourceKind; title: string; url: string; topical: boolean };
export type Course = { title: string; path: string };

export type SiteConfig = {
  siteId: string;
  domain: string;
  topics: string[];
  courses: Course[];
  sources: Source[];
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
    models: Record<"select" | "plan" | "write" | "fix" | "review" | "revise" | "image", string>;
    reasoning: Partial<Record<string, Record<string, unknown>>>;
    maxCostPerRunUsd: number;
  };
  stand: { base: string; maxFixes: number; images: string[]; memoryLimitMb: number; pyRun: string };
  gates: { minWords: number; maxWords: number; maxShingleShare: number; maxRevisions: number };
  publish: { status: "draft"; categories: number[] };
  schedule: { day: string };
  bdsBase: string;
};

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
  const publish = section(raw, "publish", { status: "draft" as const, categories: [] as number[] });
  if (publish.status !== "draft") {
    throw new Error(
      "publish.status: пока только draft — автопубликация отдельным решением после пилота",
    );
  }
  return {
    siteId: raw.site.id,
    domain: raw.site.domain,
    topics: (raw.topics as string[] | undefined) ?? [],
    courses: (raw.courses as Course[] | undefined) ?? [],
    sources,
    collect: section(raw, "collect", {
      timeoutMs: 20_000,
      simhashMaxDistance: 6,
      simhashMinWords: 20,
    }),
    select,
    llm: section(raw, "llm", {
      models: {} as SiteConfig["llm"]["models"],
      reasoning: {},
      maxCostPerRunUsd: 2,
    }),
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
    }),
    publish,
    schedule: section(raw, "schedule", { day: "mon" }),
    bdsBase: String(
      (raw.bds as { base?: string } | undefined)?.base ?? "https://bigdataschool.ru",
    ).replace(/\/+$/, ""),
  };
}

export function loadSiteConfig(path: string): SiteConfig {
  return parseSiteConfig(readFileSync(path, "utf8"));
}
