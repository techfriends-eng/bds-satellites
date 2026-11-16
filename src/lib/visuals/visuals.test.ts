import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Brand } from "../brand/brand.ts";
import { forgetSchemes, renderScheme, type Docker } from "./render.ts";

const BRAND: Brand = {
  primary: "#2F6F73",
  accent: "#A9CBD4",
  background: "#F4F8F9",
  text: "#232C3D",
};
const THEME = { brand: BRAND, base: { themeVariables: { fontSize: "26px" } } };

test("рендер схемы: mmdc с конфигами форка, JPG 1200x800 и чистка метаданных в одном контейнере", () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  const calls: string[][] = [];
  const docker: Docker = (args) => {
    calls.push(args);
    return { rc: 0, out: "" };
  };
  renderScheme(
    docker,
    "bds-sat-visuals:0.1.0",
    dir,
    "1001:1001",
    "s_scheme1.jpg",
    "flowchart LR\n a-->b",
    THEME,
  );
  assert.equal(
    readFileSync(join(dir, "s_scheme1.jpg.mmd"), "utf8"),
    "flowchart LR\n a-->b\n  classDef accent fill:#A9CBD4,stroke:#2F6F73,color:#232C3D;\n",
  );
  const conf = JSON.parse(readFileSync(join(dir, "s_scheme1.jpg.mermaid.json"), "utf8"));
  assert.equal(conf.theme, "base");
  assert.equal(conf.themeVariables.fontSize, "26px");
  assert.equal(conf.themeVariables.primaryColor, "#2F6F73");
  assert.match(conf.themeCSS, /color: #232C3D/);
  const cmd = calls[0].at(-1)!;
  assert.deepEqual(calls[0].slice(0, 7), [
    "run",
    "--rm",
    "--user",
    "1001:1001",
    "-v",
    `${dir}:/data`,
    "bds-sat-visuals:0.1.0",
  ]);
  assert.match(
    cmd,
    /mmdc -i s_scheme1\.jpg\.mmd -o s_scheme1\.jpg\.png -b '#F4F8F9' .* -c s_scheme1\.jpg\.mermaid\.json -s 3/,
  );
  assert.match(
    cmd,
    /-background '#F4F8F9' -flatten -resize '1200x800>' -quality 95 s_scheme1\.jpg/,
  );
  assert.match(cmd, /exiftool -q -overwrite_original -all= s_scheme1\.jpg/);
});

test("рендер схемы: ошибка mmdc — исключение с хвостом вывода", () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  const docker: Docker = () => ({ rc: 1, out: "Parse error on line 2\nExpecting 'SEMI'" });
  assert.throws(
    () => renderScheme(docker, "img", dir, "1:1", "f.jpg", "bad", THEME),
    /Parse error on line 2/,
  );
});

test("VERSION совпадает с package.json: по нему тег образа bds-sat-visuals и строка деплоя", () => {
  const pkg = join(import.meta.dirname, "../../..");
  const json = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
  assert.equal(readFileSync(join(pkg, "VERSION"), "utf8").trim(), json.version);
});

test("сброс схем: файлы и записи схем уходят, превью и его запись остаются", () => {
  const dir = mkdtempSync(join(tmpdir(), "sat-forget-"));
  mkdirSync(join(dir, ".work"));
  for (const f of ["a_scheme1.jpg", "a_scheme2.jpg", "a_preview.jpg"])
    writeFileSync(join(dir, f), "x");
  const media = { id: 1, url: "u" };
  writeFileSync(
    join(dir, ".work", "media.json"),
    JSON.stringify({ "a_scheme1.jpg": media, "a_preview.jpg": media }),
  );
  assert.deepEqual(forgetSchemes(dir).sort(), ["a_scheme1.jpg", "a_scheme2.jpg"]);
  assert.ok(!existsSync(join(dir, "a_scheme1.jpg")));
  assert.ok(existsSync(join(dir, "a_preview.jpg")));
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(dir, ".work", "media.json"), "utf8"))),
    ["a_preview.jpg"],
  );
});

test("R5: вертикальная схема — в команде проверка высоты и перерисовка LR; горизонтальная — без неё", () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  const calls: string[][] = [];
  const docker: Docker = (args) => {
    calls.push(args);
    return { rc: 0, out: "" };
  };
  renderScheme(docker, "img", dir, "1:1", "v.jpg", "flowchart TD\n a-->b", THEME);
  const cmd = calls[0].at(-1) ?? "";
  assert.match(cmd, /identify -format '%h' v\.jpg\.png/);
  assert.match(cmd, /mmdc -i v\.jpg\.lr\.mmd -o v\.jpg\.lr\.png/);
  assert.match(readFileSync(join(dir, "v.jpg.lr.mmd"), "utf8"), /^flowchart LR/);
  renderScheme(docker, "img", dir, "1:1", "h.jpg", "flowchart LR\n a-->b", THEME);
  assert.doesNotMatch(calls[1].at(-1) ?? "", /identify/);
});
