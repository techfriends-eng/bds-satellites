import { createHash } from "node:crypto";
import { canonicalArticleUrl } from "@techfriends-eng/toolkit/ingest";

/**
 * Ключ дедупа: канонический URL toolkit (без utm и якоря) плюс то, что для спутника тоже один материал —
 * регистр хоста, www./m., хвостовой слэш, трекинг-параметры лент, http/https, адрес видео YouTube.
 * В toolkit это не уходит: там канонический URL — id статьи stack-radar, менять его нельзя.
 */
const DROP = new Set(["fbclid", "gclid", "yclid", "ref", "source", "sk", "mc_cid", "mc_eid"]);

export function dedupUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(canonicalArticleUrl(url.trim()));
  } catch {
    return url.trim();
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host === "youtube.com" || host === "youtu.be") {
    const id = u.searchParams.get("v") ?? u.pathname.split("/").filter(Boolean).pop() ?? "";
    return `https://youtube.com/watch?v=${id}`;
  }
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !DROP.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${path}${query}`;
}

export function urlHash(url: string): string {
  return createHash("sha1").update(dedupUrl(url)).digest("hex");
}

const WORD = /[\p{L}\p{N}_]+/gu;
const TAG = /<[^>]+>/g;

export function words(text: string): string[] {
  return text.replace(TAG, " ").toLowerCase().match(WORD) ?? [];
}

/** 64-битный simhash по словным триграммам: почти-дубли одной статьи из разных лент. */
export function simhash(tokens: string[], n = 3): bigint {
  const grams: string[] = [];
  for (let i = 0; i < Math.max(1, tokens.length - n + 1); i++)
    grams.push(tokens.slice(i, i + n).join(" "));
  const acc = new Array<number>(64).fill(0);
  for (const g of grams) {
    const h = createHash("blake2b512").update(g).digest().readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit++) acc[bit] += (h >> BigInt(bit)) & 1n ? 1 : -1;
  }
  let value = 0n;
  for (let bit = 0; bit < 64; bit++) if (acc[bit] > 0) value |= 1n << BigInt(bit);
  // SQLite хранит знаковый INTEGER: переводим в диапазон int64.
  return BigInt.asIntN(64, value);
}

export function distance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
