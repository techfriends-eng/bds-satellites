import assert from "node:assert/strict";
import { test } from "node:test";
import { schemes } from "../gates/checks.ts";
import { jpegRatio, layout, verticalProblem } from "./layout.ts";

// Код реальных схем с progon (2026-11-03): spark_join_strategies_aqe (h/w 2.23) и
// kraft_quorum_loss_recovery схема 2 (h/w 5.30).
const SPARK_JOIN = `flowchart TD
    A[Equi-join] --> B{Есть join-подсказка и она допустима?}
    B -- да --> C[Стратегия из подсказки]
    B -- нет --> D{Оценка размера стороны меньше порога broadcast?}
    D -- да --> E[BroadcastHashJoin]
    D -- нет --> F{preferSortMergeJoin выключен и партиция мала?}
    F -- да --> G[ShuffledHashJoin]
    F -- нет --> H[SortMergeJoin]
    H --> I[Шафл завершён, AQE знает реальные размеры]
    I --> J{Фактический размер меньше порога AQE?}
    J -- да --> K[BroadcastHashJoin и local shuffle reader]
    J -- нет --> L{Все партиции меньше maxShuffledHashJoinLocalMapThreshold?}
    L -- да --> M[ShuffledHashJoin]
    L -- нет --> N[SortMergeJoin остаётся]
    class I,K accent`;

const KRAFT_CHAIN = `%%{init: {'theme':'base'}}%%
flowchart TD
  S1["1. Найти самый длинный лог"]
  S2["2. Остановить процессы контроллеров"]
  S3["3. Дописать VotersRecord"]
  S4["4. Запустить только его"]
  S5["5. Запустить остальные выжившие узлы"]
  S6["6. Добавить замены"]
  S1 --> S2 --> S3 --> S4 --> S5 --> S6
  classDef accent fill:#FFAB1F,stroke:#294A70,color:#294A70;
  class S4 accent;`;

test("направление: вертикальные цепочки с progon — провал, LR — ок", () => {
  assert.equal(layout(SPARK_JOIN).levels.length, 9);
  assert.match(verticalProblem(SPARK_JOIN) ?? "", /уровней 9/);
  assert.deepEqual(layout(KRAFT_CHAIN).levels, [1, 1, 1, 1, 1, 1]);
  assert.ok(verticalProblem(KRAFT_CHAIN));
  assert.equal(verticalProblem(KRAFT_CHAIN.replace("flowchart TD", "flowchart LR")), null);
});

test("направление: исключения автора — два решения в колонках, в каждом ряду от 3 блоков", () => {
  const columns = `flowchart TB
  subgraph A[Решение 1]
    a1 --> a2 --> a3
  end
  subgraph B[Решение 2]
    b1 --> b2 --> b3
  end`;
  assert.equal(verticalProblem(columns), null);
  const wide = "flowchart TB\n  r1 & r2 & r3 --> m1 & m2 & m3\n  m1 & m2 & m3 --> e1 & e2 & e3";
  assert.deepEqual(layout(wide).levels, [3, 3, 3]);
  assert.equal(verticalProblem(wide), null);
  // Узкий итоговый ряд при широкой картинке допустим (kafka 636: 3/3/1, h/w 0.69).
  const summary = "flowchart TB\n  a & b & c --> d & e & f\n  d & e & f --> z";
  assert.equal(verticalProblem(summary), null);
  assert.equal(verticalProblem(summary, 0.69), null);
  assert.ok(verticalProblem(summary, 1.4), "нарисованная картинка решает");
  assert.equal(verticalProblem(KRAFT_CHAIN, 0.9), null, "широкая картинка разрешена");
  assert.ok(verticalProblem("flowchart TB\n  a & b --> c\n  c --> d\n  d --> e"));
});

test("направление: без направления flowchart и stateDiagram сверху вниз, sequence не проверяется", () => {
  assert.ok(verticalProblem("flowchart\n  a --> b --> c --> d"));
  assert.ok(verticalProblem("graph\n  a --> b --> c"));
  assert.ok(verticalProblem("stateDiagram-v2\n  [*] --> A\n  A --> B\n  B --> [*]"));
  assert.equal(verticalProblem("stateDiagram-v2\n  direction LR\n  [*] --> A\n  A --> B"), null);
  assert.equal(verticalProblem("sequenceDiagram\n  A->>B: hi"), null);
});

test("проверка схем в gates: по каждой схеме из метаданных", () => {
  const meta = `### Схема 1. Выбор join\n\n- **Имя файла:** \`x_scheme1.jpg\`\n\n\`\`\`mermaid\n${SPARK_JOIN}\n\`\`\`\n\n### Схема 2. Поток\n\n- **Имя файла:** \`x_scheme2.jpg\`\n\n\`\`\`mermaid\nflowchart LR\n  a --> b\n\`\`\``;
  const r = schemes(meta);
  assert.equal(r.ok, false);
  assert.match(r.detail, /^схема 1: вертикальная схема/);
  assert.ok(!r.detail.includes("схема 2"));
});

test("пропорции JPEG по маркеру SOF", () => {
  // SOI, APP0 длиной 4, SOF0: длина 17, точность 8, высота 800, ширина 358.
  const jpg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x01,
    0x66, 0x03,
  ]);
  assert.equal(jpegRatio(jpg)?.toFixed(2), "2.23");
});
