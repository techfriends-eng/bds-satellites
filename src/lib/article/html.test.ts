import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadStyle } from "../style/rules.ts";
import {
  clip,
  codeIdents,
  isIdent,
  leadTerms,
  leadTermsOf,
  normalizeArticle,
  parseArticle,
  SOLUTION_SUMMARY,
  setFile,
  setOutputs,
  solutionButtons,
  tableLayout,
  splitAnswer,
} from "./html.ts";

const HTML = [
  "<p>Лид.</p>",
  '<pre class="EnlighterJSRAW" data-enlighter-language="python"># producer.py · confluent-kafka 2.6.1\nif a &lt; b and c &amp;&amp; d:\n    pass</pre>',
  '<pre class="EnlighterJSRAW" data-enlighter-language="generic">[[output producer.py]]</pre>',
  '<pre class="EnlighterJSRAW" data-enlighter-language="bash"># run.sh · Kafka 4.3.2\nset -euo pipefail</pre>',
  '<pre class="EnlighterJSRAW" data-enlighter-language="generic"># requirements.txt\nconfluent-kafka==2.6.1</pre>',
  '<pre class="EnlighterJSRAW" data-enlighter-language="generic">просто конфиг без имени</pre>',
].join("\n");

test("разбор: файлы по первой строке, HTML-сущности раскрыты, места вывода по порядку", () => {
  const { files, outputs } = parseArticle(HTML);
  assert.deepEqual([...files.keys()], ["producer.py", "run.sh", "requirements.txt"]);
  assert.equal(
    files.get("producer.py"),
    "# producer.py · confluent-kafka 2.6.1\nif a < b and c && d:\n    pass\n",
  );
  assert.deepEqual(outputs, ["producer.py"]);
});

test("вывод: вставляется экранированным на место маркера, чужие блоки не трогаются", () => {
  const html = setOutputs(HTML, { "producer.py": "x <y>\n" });
  assert.ok(
    html.includes(
      '<!-- output producer.py -->\n<pre class="EnlighterJSRAW" data-enlighter-language="generic">x &lt;y&gt;</pre>',
    ),
  );
  assert.ok(!html.includes("[[output"));
  assert.ok(html.includes("просто конфиг без имени"));
  // повторный прогон находит то же место и меняет вывод
  assert.deepEqual(parseArticle(html).outputs, ["producer.py"]);
  const again = setOutputs(html, { "producer.py": "второй прогон" });
  assert.ok(again.includes('generic">второй прогон</pre>'));
  assert.ok(!again.includes("x &lt;y&gt;"));
  assert.equal(again.match(/<!-- output producer.py -->/g)?.length, 1);
});

test("починка: код файла подменяется по имени, имя и язык сохраняются", () => {
  const html = setFile(HTML, "run.sh", "# run.sh · Kafka 4.3.2\nset -eu\n");
  assert.ok(html.includes('data-enlighter-language="bash"># run.sh · Kafka 4.3.2\nset -eu</pre>'));
  assert.equal(parseArticle(html).files.get("run.sh"), "# run.sh · Kafka 4.3.2\nset -eu\n");
});

test("сокращение вывода целыми строками с пометкой", () => {
  const out = clip(Array.from({ length: 200 }, (_, i) => String(i)).join("\n"), 30);
  assert.equal(out.split("\n").length, 31);
  assert.match(out, /пропущено строк: 170/);
});

test("ответ модели делится на статью и метаданные", () => {
  assert.deepEqual(splitAnswer("мусор\n=====ARTICLE=====\n<p>a</p>\n=====META=====\n# m\n"), {
    article: "<p>a</p>",
    meta: "# m",
  });
  assert.throws(() => splitAnswer("<p>a</p>"), /ARTICLE/);
});

test("правила: из форка берутся Style Guide и B5, дельта спутников целиком", () => {
  const style = loadStyle(join(import.meta.dirname, "..", "..", "..", "style"));
  assert.match(style.styleGuide, /^## STYLE GUIDE V10-Blog/);
  assert.match(style.styleGuide, /### B5\.2\. Превью-картинка/);
  assert.ok(!style.styleGuide.includes("## B6."));
  assert.match(style.satDelta, /Баннеров `\[cbanner\]`/);
});

test("правила: общие R1–R6 из копии bds-content, без шапки форка и путей плагина", () => {
  const style = loadStyle(join(import.meta.dirname, "..", "..", "..", "style"));
  assert.match(style.contentRules, /^# Общие правила контента BDS/);
  for (const code of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
    assert.match(style.contentRules, new RegExp(`^## ${code}\\. `, "m"), code);
  }
  assert.ok(!style.contentRules.includes("<!--"));
  assert.ok(!style.styleGuide.includes("CLAUDE_PLUGIN_ROOT"));
  assert.match(style.styleGuide, /общие правила R1–R6 в блоке выше/);
});

test("разбор: у run.sh с shebang имя во второй строке, починка находит тот же блок", () => {
  const html = `<pre class="EnlighterJSRAW" data-enlighter-language="bash">#!/usr/bin/env bash
# run.sh · Spark 4.0.4
docker compose up -d</pre>`;
  const { files } = parseArticle(html);
  assert.deepEqual([...files.keys()], ["run.sh"]);
  assert.match(setFile(html, "run.sh", "#!/usr/bin/env bash\n# run.sh\necho ok"), /echo ok/);
});

test("кнопка решения: любой summary со словом «Решение» приводится к образцу, другие не трогаем", () => {
  const html = [
    "<details><summary>Решение</summary><p>a</p></details>",
    '<details><summary class="x"><em>Решение задания 2</em></summary><p>b</p></details>',
    "<details><summary>Подсказка</summary><p>c</p></details>",
  ].join("\n");
  const out = solutionButtons(html);
  assert.equal(out.split(`<summary>${SOLUTION_SUMMARY}</summary>`).length - 1, 2);
  assert.ok(out.includes("<summary>Подсказка</summary>"));
  assert.equal(solutionButtons(out), out);
});

test("tableLayout: ширина по тексту, влево, перенос длинных имён (ToDo 104)", () => {
  const html = [
    "<p>До.</p>",
    "<table><thead><tr><th>Стратегия</th><th>Когда применяется</th><th>Параметр</th></tr></thead><tbody>",
    "<tr><td>BroadcastHashJoin</td><td>Одна сторона мала и может быть build side, оценка размера верна</td><td>spark.sql.autoBroadcastJoinThreshold</td></tr>",
    '<tr><td>SortMergeJoin</td><td>Обе стороны велики, <a href="https://spark.apache.org/docs/x.y">вариант</a> по умолчанию</td><td>нет</td></tr>',
    "</tbody></table>",
  ].join("\n");
  const out = tableLayout(html);
  assert.ok(out.includes("<table><thead>"), "тег table без атрибутов: по нему ищет линтер");
  const widths = [...out.matchAll(/<th style="width:(\d+)%;text-align:left">/g)].map((m) =>
    Number(m[1]),
  );
  assert.equal(widths.length, 3);
  assert.equal(
    widths.reduce((a, b) => a + b, 0),
    100,
  );
  assert.ok(widths[1] > widths[0] && widths[1] > widths[2], `текстовая колонка шире: ${widths}`);
  assert.equal(out.match(/<td style="text-align:left">/g)?.length, 6);
  assert.ok(out.includes("spark.<wbr>sql.<wbr>auto<wbr>Broadcast<wbr>Join<wbr>Threshold"));
  assert.ok(out.includes('href="https://spark.apache.org/docs/x.y"'), "атрибуты ссылок не трогаем");
  assert.ok(
    out.includes(">Broadcast<wbr>Hash<wbr>Join</td>"),
    "длинное CamelCase-имя рвётся по словам",
  );
  assert.ok(out.includes(">SortMergeJoin</td>"), "короче LONG_WORD не рвём");
  assert.equal(tableLayout(out), out);
  assert.equal(tableLayout("<p>нет таблиц</p>"), "<p>нет таблиц</p>");
});

test("isIdent: какие имена уходят в code (ToDo 104)", () => {
  for (const w of [
    "SortMergeJoin",
    "BroadcastNestedLoopJoin",
    "spark.sql.shuffle.partitions",
    "autoBroadcastJoinThreshold",
    "groupBy",
    "left_anti",
    "__consumer_offsets",
    "producer.py",
    "df.groupBy",
    "count()",
    "KAFKA_HEAP_OPTS",
    "org.apache.kafka.Consumer",
  ])
    assert.ok(isIdent(w), w);
  for (const w of [
    "ClickHouse",
    "PySpark",
    "DataFrame",
    "macOS",
    "Node.js",
    "kafka-school.ru",
    "spark-school.ru",
    "Kafka",
    "API",
    "v0",
    "index.html",
  ])
    assert.ok(!isIdent(w), w);
});

test("codeIdents: имена в code, код, ссылки, заголовки и strong не трогаем", () => {
  const html = [
    "<h2>Когда выбирают SortMergeJoin</h2>",
    "<p>Порог spark.sql.autoBroadcastJoinThreshold решает, будет ли BroadcastHashJoin. Иначе SortMergeJoin.</p>",
    '<p><a href="https://x.org/spark.sql.a_b">ShuffledHashJoin</a> и <strong>SortMergeJoin</strong></p>',
    '<pre class="EnlighterJSRAW" data-enlighter-language="python">df.groupBy("k").count()</pre>',
    "<!-- output run_job.py -->",
    "<details><summary>Решение</summary><p>Вызовите df.groupBy и count().</p></details>",
    "<p>Сайт kafka-school.ru, DataFrame и PySpark остаются текстом.</p>",
  ].join("\n");
  const out = codeIdents(html);
  assert.ok(out.includes("<h2>Когда выбирают SortMergeJoin</h2>"));
  assert.ok(out.includes("Порог <code>spark.sql.autoBroadcastJoinThreshold</code> решает"));
  assert.ok(
    out.includes("будет ли <code>BroadcastHashJoin</code>. Иначе <code>SortMergeJoin</code>.</p>"),
  );
  assert.ok(out.includes('href="https://x.org/spark.sql.a_b">ShuffledHashJoin</a>'));
  assert.ok(out.includes("<strong>SortMergeJoin</strong>"));
  assert.ok(out.includes('df.groupBy("k").count()</pre>'));
  assert.ok(out.includes("<!-- output run_job.py -->"));
  assert.ok(out.includes("Вызовите <code>df.groupBy</code> и <code>count()</code>."));
  assert.ok(out.includes("Сайт kafka-school.ru, DataFrame и PySpark остаются текстом."));
  assert.equal(codeIdents(out), out);
});

test("normalizeArticle: code в таблице и перенос внутри него, повторный вызов стабилен", () => {
  const html =
    "<table><thead><tr><th>Стратегия</th><th>Параметр</th></tr></thead><tbody>" +
    "<tr><td>BroadcastHashJoin</td><td>spark.sql.autoBroadcastJoinThreshold</td></tr></tbody></table>";
  const out = normalizeArticle(html);
  assert.ok(out.includes("<code>Broadcast<wbr>Hash<wbr>Join</code>"), out);
  assert.ok(
    out.includes("<code>spark.<wbr>sql.<wbr>auto<wbr>Broadcast<wbr>Join<wbr>Threshold</code>"),
  );
  assert.equal(normalizeArticle(out), out);
});

test("leadTermsOf: строка meta как у линтера, обратные кавычки снимаются", () => {
  const meta =
    "- **Slug:** x\n- **Главные термины:** Kafka log compaction, `dedupe buffer`, WarpStream\n";
  assert.deepEqual(leadTermsOf(meta), ["Kafka log compaction", "dedupe buffer", "WarpStream"]);
  assert.deepEqual(leadTermsOf("- **Slug:** x"), []);
});

test("leadTerms: термины лида жирным один раз, лишний жирный снят, повтор стабилен (kafka 553)", () => {
  const html =
    "&nbsp;\n<p><b>Важно.</b> Kafka log compaction в Kafka хранит последнее значение, у <code>dedupe buffer</code> " +
    "и dedupe buffer по материалу WarpStream, снова Kafka log compaction.</p>\n<p>Kafka log compaction дальше.</p>";
  const terms = ["Kafka", "Kafka log compaction", "dedupe buffer", "WarpStream", "нет в лиде"];
  const out = leadTerms(html, terms);
  assert.equal(
    out,
    "&nbsp;\n<p>Важно. <strong>Kafka log compaction</strong> в <strong>Kafka</strong> хранит последнее значение, у " +
      "<code>dedupe buffer</code> и <strong>dedupe buffer</strong> по материалу <strong>WarpStream</strong>, снова " +
      "Kafka log compaction.</p>\n<p>Kafka log compaction дальше.</p>",
  );
  assert.equal(leadTerms(out, terms), out);
  assert.equal(normalizeArticle(out, terms), normalizeArticle(normalizeArticle(out, terms), terms));
});

test("leadTerms: термин только целым словом, регистр текста сохраняется", () => {
  assert.equal(
    leadTerms("<p>kafkaesque и kafka.</p>", ["Kafka"]),
    "<p>kafkaesque и <strong>kafka</strong>.</p>",
  );
  assert.equal(leadTerms("<p>текст</p>", []), "<p>текст</p>");
});
