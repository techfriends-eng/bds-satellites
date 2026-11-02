import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSiteConfig } from "../config/site.ts";
import { loadStyle } from "../style/rules.ts";
import {
  brandMermaid,
  brandPreviewPrompt,
  contrast,
  isBdsColor,
  mermaidConfig,
  parseBrand,
  type Brand,
} from "./brand.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const KAFKA: Brand = {
  primary: "#2F6F73",
  accent: "#A9CBD4",
  background: "#F4F8F9",
  text: "#232C3D",
};
const SPARK: Brand = {
  primary: "#3A3D45",
  accent: "#B52D0D",
  background: "#FAF8F7",
  text: "#1E1D24",
};
const PYTHON: Brand = {
  primary: "#2F6B14",
  accent: "#62BE1E",
  background: "#F6FAF3",
  text: "#232C3D",
};

test("палитры трёх сайтов проходят проверку, контраст текста от 4.5", () => {
  for (const b of [KAFKA, SPARK, PYTHON]) assert.deepEqual(parseBrand(b), b);
  assert.ok(contrast("#FFFFFF", SPARK.accent) >= 4.5);
});

test("brand обязателен, цвет только #RRGGBB", () => {
  assert.throws(() => parseBrand(undefined), /brand обязателен.*brand-suggest/);
  assert.throws(() => parseBrand({ ...KAFKA, accent: "teal" }), /brand\.accent/);
  assert.throws(() => parseBrand({ ...KAFKA, text: undefined }), /brand\.text/);
});

test("конфиг сайта без brand не разбирается, шаблон нового сайта тоже: это вопрос автору", () => {
  const template = readFileSync(join(ROOT, "templates/site/config/site.yaml"), "utf8")
    .replaceAll("__SITE__", "new")
    .replaceAll("__DOMAIN__", "new-school.ru");
  assert.throws(() => parseSiteConfig(template), /brand обязателен/);
});

test("палитра BDS запрещена: точные цвета и близкие по оттенку", () => {
  assert.throws(() => parseBrand({ ...KAFKA, primary: "#294A70" }), /bigdataschool/);
  assert.throws(() => parseBrand({ ...KAFKA, primary: "#2A4B72" }), /bigdataschool/);
  assert.throws(() => parseBrand({ ...KAFKA, accent: "#FFAB1F" }), /bigdataschool/);
  assert.throws(() => parseBrand({ ...KAFKA, background: "#f5f7fa" }), /bigdataschool/);
  assert.equal(isBdsColor(KAFKA.primary), false);
  assert.equal(isBdsColor(SPARK.primary), false, "графит без оттенка не синий BDS");
});

test("низкий контраст: ошибка с цветом", () => {
  assert.throws(() => parseBrand({ ...KAFKA, text: "#BBBBBB" }), /text на background/);
  assert.throws(() => parseBrand({ ...KAFKA, primary: "#CCE0E2" }), /primary на background/);
});

test("схема: init, frontmatter, style и linkStyle модели отброшены, classDef стал акцентом сайта", () => {
  const out = brandMermaid(
    `---
config: {theme: forest}
---
%%{init: {'theme':'base', 'themeVariables': {
  'primaryColor':'#294A70'
}}}%%
flowchart LR
  a[Брокер] --> b[Контроллер]
  classDef accent fill:#FFAB1F,stroke:#294A70,color:#294A70;
  classDef hot fill:#FF0000;
  classDef default fill:#123456;
  class b accent
  style a fill:#00FF00,stroke:#000
  linkStyle 0 stroke:#FF00FF
  linkStyle default interpolate basis`,
    KAFKA,
  );
  const accent = "fill:#A9CBD4,stroke:#2F6F73,color:#232C3D;";
  assert.equal(
    out,
    `flowchart LR
  a[Брокер] --> b[Контроллер]
  classDef accent ${accent}
  classDef hot ${accent}
  class b accent
  linkStyle default interpolate basis`,
  );
});

test("схема: акцент дописан у flowchart и state, у последовательности нет classDef, rect в цвете фона", () => {
  assert.match(brandMermaid("graph TD\n a-->b", KAFKA), /classDef accent fill:#A9CBD4/);
  assert.match(brandMermaid("stateDiagram-v2\n A --> B", KAFKA), /classDef accent/);
  const seq = brandMermaid(
    "sequenceDiagram\n  box rgb(1,2,3) Кластер\n  participant A\n  end\n  rect rgba(255,0,0,0.5)\n  A->>A: x\n  end",
    KAFKA,
  );
  assert.doesNotMatch(seq, /classDef|rgba|1,2,3/);
  assert.match(seq, /box Кластер/);
  assert.match(seq, /rect rgb\(244,248,249\)/);
});

test("тема mmdc: база форка сохранена, цветов BDS нет, подписи дуг и фон из brand", () => {
  const base = JSON.parse(readFileSync(join(ROOT, "visuals/mermaid_theme_override.json"), "utf8"));
  const conf = mermaidConfig(base, SPARK) as { themeVariables: Record<string, string> };
  assert.equal(conf.themeVariables.fontSize, "26px");
  assert.equal(conf.themeVariables.edgeLabelBackground, SPARK.background);
  assert.equal(conf.themeVariables.secondaryTextColor, "#FFFFFF", "белый на красном");
  const text = JSON.stringify(conf);
  for (const c of ["#294A70", "#FFAB1F", "#F5F7FA"]) assert.ok(!text.includes(c), c);
});

test("превью: цвета модели убраны, палитра сайта дописана", () => {
  const out = brandPreviewPrompt(
    "Server rack, photorealistic, palette #294A70 #FFAB1F #F5F7FA, 1200x800, no busy background",
    SPARK,
  );
  assert.doesNotMatch(out, /294A70|FFAB1F|F5F7FA|palette #/);
  assert.match(out, /Server rack, photorealistic, 1200x800, no busy background/);
  assert.match(out, /main #3A3D45, accent #B52D0D, light background #FAF8F7/);
});

test("правила в промпте без палитры BDS, копия upstream не менялась", () => {
  const { styleGuide, satDelta } = loadStyle(join(ROOT, "style"));
  for (const c of ["#294A70", "#FFAB1F", "#F5F7FA"]) {
    assert.ok(!styleGuide.includes(c), `${c} в Style Guide`);
    assert.ok(!satDelta.includes(c), `${c} в sat-delta`);
  }
  assert.doesNotMatch(styleGuide, /палитру из K5|init-блок фирменных/);
  const upstream = readFileSync(join(ROOT, "style/upstream/article-write.rules.md"), "utf8");
  assert.ok(upstream.includes("#294A70"));
});
