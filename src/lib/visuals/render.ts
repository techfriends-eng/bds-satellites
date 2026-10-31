import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Картинки статьи в контейнере bds-sat-visuals (visuals/Dockerfile, форк wiki_visualizer):
 * Mermaid → PNG (scale 3, шрифт и CSS подписей из visuals/), затем JPG 1200×800 на фоне палитры и
 * чистка метаданных exiftool. Контейнер идёт с uid хоста и видит только каталог черновика.
 */
export type Docker = (args: string[]) => { rc: number; out: string };

export const dockerCli: Docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
  return { rc: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const BG = "#F5F7FA"; // brand_colors[2] из visuals/image_spec.json
const FINAL = "1200x800";

function run(docker: Docker, image: string, dir: string, uid: string, cmd: string): void {
  const r = docker(["run", "--rm", "--user", uid, "-v", `${dir}:/data`, image, "bash", "-c", cmd]);
  if (r.rc !== 0) throw new Error(r.out.trim().split("\n").slice(-5).join(" | "));
}

/** Сжимает до 1200×800 без обрезки (">"), фон палитры, JPEG 95, без метаданных. */
function finalize(png: string, jpg: string): string {
  return `convert ${png} -background '${BG}' -flatten -resize '${FINAL}>' -quality 95 ${jpg} && exiftool -q -overwrite_original -all= ${jpg} && rm -f ${png}`;
}

export function renderScheme(
  docker: Docker,
  image: string,
  dir: string,
  uid: string,
  file: string,
  mermaid: string,
): void {
  const mmd = `${file}.mmd`;
  writeFileSync(join(dir, mmd), `${mermaid}\n`);
  const png = `${file}.png`;
  run(
    docker,
    image,
    dir,
    uid,
    `mmdc -i ${mmd} -o ${png} -b '${BG}' -p /visuals/puppeteer-config.json -c /visuals/mermaid_theme_override.json -s 3 && rm -f ${mmd} && ${finalize(png, file)}`,
  );
}

/** Превью из готового PNG/JPEG модели: тот же размер, фон и чистка метаданных (C2PA модели). */
export function finalizePreview(
  docker: Docker,
  image: string,
  dir: string,
  uid: string,
  raw: string,
  file: string,
): void {
  run(docker, image, dir, uid, finalize(raw, file));
}
