import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, parseEdits } from "./edits.ts";

test("пары: разбор статьи и метаданных, пустой REPLACE — удаление, текст до первой метки игнорируется", () => {
  const edits = parseEdits(
    "вот правка\n=====FIND ARTICLE=====\n<p>a</p>\n=====REPLACE=====\n<p>b</p>\n\n=====FIND META=====\n# m\n=====REPLACE=====\n# m2\n=====FIND ARTICLE=====\n  <p>x</p>\n=====REPLACE=====\n",
  );
  assert.deepEqual(edits, [
    { target: "article", find: "<p>a</p>", replace: "<p>b</p>" },
    { target: "meta", find: "# m", replace: "# m2" },
    { target: "article", find: "  <p>x</p>", replace: "" },
  ]);
  assert.throws(() => parseEdits("=====ARTICLE=====\n<p>a</p>"), /нет пар/);
  assert.throws(() => parseEdits("=====FIND ARTICLE=====\na\n=====FIND META=====\nb"), /REPLACE/);
});

test("пары: ровно одно вхождение применяется, нет или два — в failed, $ в замене не спецсимвол", () => {
  const files = { article: "<p>a</p>\n<p>b</p>\n<p>b</p>\n", meta: "# m\n" };
  const ok = applyEdits(files, [
    { target: "article", find: "<p>a</p>", replace: "<p>$& 5$</p>" },
    { target: "meta", find: "# m", replace: "# m2" },
  ]);
  assert.deepEqual(ok, {
    article: "<p>$& 5$</p>\n<p>b</p>\n<p>b</p>\n",
    meta: "# m2\n",
    failed: [],
  });
  const bad = applyEdits(files, [
    { target: "article", find: "<p>b</p>", replace: "" },
    { target: "article", find: "<p>нет</p>", replace: "" },
  ]);
  assert.match(bad.failed[0], /2 раз/);
  assert.match(bad.failed[1], /нет в статье/);
  assert.deepEqual(applyEdits(files, []).failed, ["нет ни одной пары замен"]);
});
