import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseVisuals } from "./meta.ts";
import { generatePreview } from "./preview.ts";
import { renderScheme, type Docker } from "./render.ts";

const META = `# Метаданные статьи X

- **Термин:** KRaft

## Часть 2. Визуализации

### Превью-картинка

- **Имя файла:** \`kraft_quorum_preview.jpg\`
- **ALT:** Три контроллера KRaft на стенде

    Photorealistic server rack, three glowing nodes, palette #294A70 #FFAB1F.
    No unreadable text.

### Схема 1. Кворум

- **Имя файла:** \`kraft_quorum_scheme1.jpg\`
- **ALT:** Кворум из трёх контроллеров и брокер

\`\`\`mermaid
%%{init: {'theme':'base'}}%%
flowchart LR
  a --> b
\`\`\`

### Схема 2. Восстановление

- **Имя файла:** \`kraft_quorum_scheme2.jpg\`
- **ALT:** Порядок восстановления

\`\`\`mermaid
flowchart TD
  x --> y
\`\`\`

## SEO
`;

test("метаданные: превью с промптом, схемы по номерам с кодом Mermaid", () => {
  const v = parseVisuals(META);
  assert.deepEqual(v.preview, {
    file: "kraft_quorum_preview.jpg",
    alt: "Три контроллера KRaft на стенде",
    prompt:
      "Photorealistic server rack, three glowing nodes, palette #294A70 #FFAB1F.\nNo unreadable text.",
  });
  assert.deepEqual(
    v.schemes.map((s) => [s.n, s.file, s.mermaid.split("\n").pop()]),
    [
      [1, "kraft_quorum_scheme1.jpg", "  a --> b"],
      [2, "kraft_quorum_scheme2.jpg", "  x --> y"],
    ],
  );
});

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
  );
  assert.equal(readFileSync(join(dir, "s_scheme1.jpg.mmd"), "utf8"), "flowchart LR\n a-->b\n");
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
    /mmdc -i s_scheme1\.jpg\.mmd .* -c \/visuals\/mermaid_theme_override\.json -s 3/,
  );
  assert.match(cmd, /-resize '1200x800>' -quality 95 s_scheme1\.jpg/);
  assert.match(cmd, /exiftool -q -overwrite_original -all= s_scheme1\.jpg/);
});

test("рендер схемы: ошибка mmdc — исключение с хвостом вывода", () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  const docker: Docker = () => ({ rc: 1, out: "Parse error on line 2\nExpecting 'SEMI'" });
  assert.throws(
    () => renderScheme(docker, "img", dir, "1:1", "f.jpg", "bad"),
    /Parse error on line 2/,
  );
});

test("превью: запасная модель маршрутом fallback, картинка из data URI, стоимость", async () => {
  let sent: Record<string, unknown> = {};
  const fake = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        usage: { cost: 0.04 },
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`,
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const r = await generatePreview({ apiKey: "k", models: ["a", "b"], prompt: "p", fetch: fake });
  assert.equal(r.bytes.toString(), "PNG");
  assert.equal(r.costUsd, 0.04);
  assert.deepEqual(sent.models, ["a", "b"]);
  assert.equal(sent.route, "fallback");
  assert.deepEqual(sent.modalities, ["image", "text"]);
});

test("метаданные: отклонения модели — превью под ##, промпт строкой, без маркеров", () => {
  const v = parseVisuals(
    "## Превью-картинка\n\n**Имя файла:** s_preview.jpg\n\n**ALT:** превью статьи\n\n**Промпт (Nano Banana Pro, 1200x800):** Photorealistic desk.\n\n## Схемы\n",
  );
  assert.deepEqual(v.preview, {
    file: "s_preview.jpg",
    alt: "превью статьи",
    prompt: "Photorealistic desk.",
  });
});
