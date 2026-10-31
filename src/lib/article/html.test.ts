import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadStyle } from "../style/rules.ts";
import { clip, parseArticle, setFile, setOutputs, splitAnswer } from "./html.ts";

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
