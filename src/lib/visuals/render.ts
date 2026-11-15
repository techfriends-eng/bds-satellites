import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brandMermaid, mermaidConfig, type Brand } from "../brand/brand.ts";

/**
 * Картинки статьи в контейнере bds-sat-visuals (visuals/Dockerfile, форк wiki_visualizer):
 * Mermaid → PNG (scale 3, шрифт из visuals/, цвета из brand сайта), затем JPG 1200×800 на фоне brand и
 * чистка метаданных exiftool. Контейнер идёт с uid хоста и видит только каталог черновика.
 */
export type Docker = (args: string[]) => { rc: number; out: string };

export const dockerCli: Docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
  return { rc: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const FINAL = "1200x800";

function run(docker: Docker, image: string, dir: string, uid: string, cmd: string): void {
  const r = docker(["run", "--rm", "--user", uid, "-v", `${dir}:/data`, image, "bash", "-c", cmd]);
  if (r.rc !== 0) throw new Error(r.out.trim().split("\n").slice(-5).join(" | "));
}

/** Сжимает до 1200×800 без обрезки (">"), фон палитры, JPEG 95, без метаданных. */
function finalize(png: string, jpg: string, background: string): string {
  return `convert ${png} -background '${background}' -flatten -resize '${FINAL}>' -quality 95 ${jpg} && exiftool -q -overwrite_original -all= ${jpg} && rm -f ${png}`;
}

/**
 * bds-content content-rules R5: направление graph/flowchart и direction в subgraph TB/TD/BT → LR.
 * Остальной код схемы не меняется. Копия `mermaid_force_lr` из wiki_visualizer (lib/mermaid_render.sh).
 */
export function forceLR(mermaid: string): string {
  return mermaid
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*(?:graph|flowchart))\s+(?:TB|TD|BT)\b/, "$1 LR")
        .replace(/^(\s*direction)\s+(?:TB|TD|BT)\b/, "$1 LR"),
    )
    .join("\n");
}

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
  const mmd = `${file}.mmd`;
  const conf = `${file}.mermaid.json`;
  writeFileSync(join(dir, mmd), `${brandMermaid(mermaid, theme.brand)}\n`);
  writeFileSync(join(dir, conf), JSON.stringify(mermaidConfig(theme.base, theme.brand)));
  const bg = theme.brand.background;
  const png = `${file}.png`;
  const mmdc = (input: string, output: string) =>
    `mmdc -i ${input} -o ${output} -b '${bg}' -p /visuals/puppeteer-config.json -c ${conf} -s 3`;
  // R5: PNG выше, чем шире, — перерисовать с LR и взять, если он не выше, чем шире.
  const lr = forceLR(mermaid);
  let retry = "";
  if (lr !== mermaid) {
    const lrMmd = `${file}.lr.mmd`;
    const lrPng = `${file}.lr.png`;
    writeFileSync(join(dir, lrMmd), `${brandMermaid(lr, theme.brand)}\n`);
    const taller = (p: string) =>
      `[ "$(identify -format '%h' ${p})" -gt "$(identify -format '%w' ${p})" ]`;
    retry =
      ` && if ${taller(png)}; then ${mmdc(lrMmd, lrPng)} && if ! ${taller(lrPng)}; then mv ${lrPng} ${png}; fi; fi` +
      ` && rm -f ${lrMmd} ${lrPng}`;
  }
  run(
    docker,
    image,
    dir,
    uid,
    `${mmdc(mmd, png)}${retry} && rm -f ${mmd} ${conf} && ${finalize(png, file, bg)}`,
  );
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
  run(docker, image, dir, uid, finalize(raw, file, background));
}
