import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBrand, type Brand } from "./brand.ts";
import { brandYaml, checkBrand, fetchSiteColors, siteColors, suggestBrand } from "./homepage.ts";

const page = (colors: Record<string, number>) =>
  Object.entries(colors)
    .map(([c, n]) => `a{color:${c}}`.repeat(n))
    .join("\n");

// Счётчики сняты с главных страниц 2 ноября.
const KAFKA_PAGE = page({
  "#5ca2a2": 89,
  "#ffffff": 70,
  "#232c3d": 43,
  "#a9cbd4": 35,
  "#e3e9ee": 13,
});
const SPARK_PAGE = page({
  "#b52d0d": 89,
  "#ffffff": 71,
  "#232c3d": 43,
  "#e3e9ee": 13,
  "#721818": 3,
});
const PYTHON_PAGE = page({ "#62be1e": 92, "#ffffff": 75, "#232c3d": 43, "#fe8a01": 1 });
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

test("цвета страницы: нейтральные, тема и пресеты WordPress, единичные цвета не считаются", () => {
  assert.deepEqual(
    siteColors(`${KAFKA_PAGE}\n--wp--preset--color--vivid-red: #cf2e2e;`).map((c) => c.hex),
    ["#5CA2A2", "#A9CBD4"],
  );
  assert.deepEqual(
    siteColors(PYTHON_PAGE).map((c) => c.hex),
    ["#62BE1E"],
  );
});

test("brand-check: палитры трёх сайтов проходят, графит оттенка не имеет", () => {
  assert.deepEqual(checkBrand(KAFKA, siteColors(KAFKA_PAGE)).problems, []);
  assert.deepEqual(checkBrand(SPARK, siteColors(SPARK_PAGE)).problems, []);
  assert.deepEqual(checkBrand(PYTHON, siteColors(PYTHON_PAGE)).problems, []);
});

test("brand-check: чужой оттенок, палитра BDS и страница без цветов не проходят", () => {
  const foreign = checkBrand(SPARK, siteColors(KAFKA_PAGE));
  assert.equal(foreign.ok, false);
  assert.match(foreign.problems.join(), /accent #B52D0D: оттенок далёк/);
  const bds = checkBrand({ ...KAFKA, primary: "#294A70" }, siteColors(KAFKA_PAGE));
  assert.match(bds.problems.join(), /bigdataschool/);
  assert.match(checkBrand(KAFKA, []).problems.join(), /сверить не с чем/);
  const neutral = checkBrand(
    { ...KAFKA, primary: "#3A3D45", accent: "#AAAAAA" },
    siteColors(KAFKA_PAGE),
  );
  assert.match(neutral.problems.join(), /без оттенка/);
});

test("brand-suggest: палитра проходит и разбор конфига, и brand-check своего сайта", () => {
  for (const html of [KAFKA_PAGE, SPARK_PAGE, PYTHON_PAGE]) {
    const site = siteColors(html);
    const b = suggestBrand(site);
    assert.ok(b);
    assert.deepEqual(parseBrand(b), b);
    assert.deepEqual(checkBrand(b, site).problems, []);
    assert.match(brandYaml(b), /^brand: \{ primary: "#[0-9A-F]{6}"/);
  }
  assert.equal(suggestBrand([]), null);
});

test("brand-suggest: сайт в цветах BDS получает другой оттенок", () => {
  const b = suggestBrand([{ hex: "#294A70", count: 50 }]);
  assert.ok(b);
  assert.deepEqual(parseBrand(b), b);
  assert.notEqual(b.primary, "#294A70");
});

test("цвета из таблиц стилей домена, когда в разметке их нет, чужой домен не читается", async () => {
  const seen: string[] = [];
  const doFetch = (async (url: string) => {
    seen.push(url);
    if (url.endsWith(".css")) return new Response("a{color:#62be1e}");
    return new Response(
      `<link rel='stylesheet' href='/t.css'><link rel='stylesheet' href='https://cdn.example/x.css'>`,
    );
  }) as typeof fetch;
  const colors = await fetchSiteColors("python-school.ru", doFetch);
  assert.deepEqual(
    colors.map((c) => c.hex),
    ["#62BE1E"],
  );
  assert.deepEqual(seen, ["https://python-school.ru/", "https://python-school.ru/t.css"]);
});
