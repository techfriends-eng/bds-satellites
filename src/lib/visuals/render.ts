import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dockerRunner,
  finalizePreview as finalizeWith,
  renderScheme as renderWith,
  type Docker,
} from "@techfriends-eng/toolkit/visuals";
import { brandMermaid, mermaidConfig, type Brand } from "../brand/brand.ts";

/**
 * Картинки статьи в контейнере bds-sat-visuals (visuals/Dockerfile). Рендер, R5 и доводка — toolkit/visuals
 * (bds-content ADR 0001, п. 4c); здесь только то, что принадлежит спутникам: палитра сайта (brand),
 * путь к puppeteer-config в образе и сброс схем вместе с media.json.
 */
export { dockerCli, forceLR, type Docker } from "@techfriends-eng/toolkit/visuals";

const PUPPETEER = "/visuals/puppeteer-config.json";

/** Палитра сайта и база параметров mmdc (visuals/mermaid_theme_override.json). */
export type SchemeTheme = { brand: Brand; base: Record<string, unknown> };

export function renderScheme(
  docker: Docker,
  image: string,
  dir: string,
  uid: string,
  file: string,
  mermaid: string,
  theme: SchemeTheme,
): void {
  renderWith(dockerRunner({ image, dir, uid, docker }), dir, file, mermaid, {
    background: theme.brand.background,
    config: mermaidConfig(theme.base, theme.brand),
    decorate: (code) => brandMermaid(code, theme.brand),
    puppeteerConfig: PUPPETEER,
  });
}

/** Превью из готового PNG/JPEG модели: тот же размер, фон и чистка метаданных (C2PA модели). */
export function finalizePreview(
  docker: Docker,
  image: string,
  dir: string,
  uid: string,
  raw: string,
  file: string,
  background: string,
): void {
  finalizeWith(dockerRunner({ image, dir, uid, docker }), raw, file, { background });
}

/**
 * Забыть готовые схемы: файлы и их записи в media.json. Следующие visuals и publish нарисуют их заново
 * и загрузят новыми файлами. Старые остаются в медиатеке WP. Превью не трогаем: оно платное.
 */
export function forgetSchemes(dir: string): string[] {
  const isScheme = (f: string) => /_scheme\d+\.jpg$/.test(f);
  const gone = readdirSync(dir).filter(isScheme);
  for (const f of gone) rmSync(join(dir, f), { force: true });
  const mediaFile = join(dir, ".work", "media.json");
  if (existsSync(mediaFile)) {
    const media = JSON.parse(readFileSync(mediaFile, "utf8")) as Record<string, unknown>;
    writeFileSync(
      mediaFile,
      JSON.stringify(
        Object.fromEntries(Object.entries(media).filter(([k]) => !isScheme(k))),
        null,
        1,
      ),
    );
  }
  return gone;
}
