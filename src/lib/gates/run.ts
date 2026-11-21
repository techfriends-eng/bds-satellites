import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, parseEdits, type Edit } from "../article/edits.ts";
import {
  leadTermsOf,
  normalizeArticle,
  outputsOf,
  parseArticle,
  setOutputs,
} from "../article/html.ts";
import { ARTICLE_MAX_TOKENS, draftPaths } from "../generate/draft.ts";
import { parseJson } from "../llm/client.ts";
import { render } from "../prompts/render.ts";
import type { Style } from "../style/rules.ts";
import type { Db } from "../store/db.ts";
import { checkDraft, type StandDeps } from "../stand/check.ts";
import { images, links, lint, sourceUse, uniqueness, type Check, type Head } from "./checks.ts";

/**
 * Проверки и переписывание. Линтер оформления, образы, ссылки, уникальность, смысловая проверка
 * (текст против реального вывода). Провал — переписывание по выводу, замечаниям и провалам линтера,
 * при смене кода — повторный прогон, не больше gates.maxRevisions кругов.
 */
export type Issue = {
  kind?: string;
  severity: string;
  quote: string;
  problem: string;
  fix?: string;
};

/**
 * Серьёзность по типу замечания. Модель выбирает тип, оценку ставит код: так модель не может поднять
 * «вывод шире замера» до high (так было в прогонах 10–16.11). Тип вне списка — high.
 */
export const KIND_SEVERITY: Record<string, "high" | "medium" | "low"> = {
  output_mismatch: "high",
  unsupported_fact: "high",
  // Стиль подачи, а не неверный факт: идут в правку, но не валят статью (решение автора 18.11).
  prep_mention: "medium",
  source_detail: "medium",
  broader_than_measured: "medium",
  outdated: "medium",
  retelling: "medium",
  minor: "low",
};
export type GatesReport = { ok: boolean; checks: Record<string, Check>; review: Issue[] };

export type GateDeps = StandDeps & { style: Style; lintPy: string; head: Head };
type Draft = { candidate_id: number; dir: string };

function research(dir: string): {
  source: string;
  docs: string;
  plan: { key?: string; source_use?: unknown };
} {
  const p = join(dir, ".work", "research.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { source: "", docs: "", plan: {} };
}

export async function review(
  deps: GateDeps,
  html: string,
  docs: string,
  candidateId: number,
): Promise<Issue[]> {
  const { system, user } = render(deps.promptDirs, "review", deps.cfg, {
    docs: docs || "(нет)",
    draft: html,
  });
  const issues =
    parseJson<{ issues?: Issue[] }>(await deps.llm.ask("review", system, user, 24_000, candidateId))
      .issues ?? [];
  // Без типа или с чужим типом — серьёзно: сбой формата ответа не должен давать PASS.
  for (const i of issues) i.severity = KIND_SEVERITY[i.kind ?? ""] ?? "high";
  return issues;
}

export async function gate(deps: GateDeps, draft: Draft, slug: string): Promise<GatesReport> {
  const { db, cfg } = deps;
  const paths = draftPaths(draft.dir, slug);
  // Правки revise и align и черновики до v0.1.40 могли оставить старую кнопку: чиним до линтера.
  const raw = readFileSync(paths.html, "utf8");
  const html = normalizeArticle(
    raw,
    existsSync(paths.meta) ? leadTermsOf(readFileSync(paths.meta, "utf8")) : [],
  );
  if (html !== raw) writeFileSync(paths.html, html);
  const cand = db.prepare("SELECT url FROM candidates WHERE id = ?").get(draft.candidate_id) as {
    url: string;
  };
  const r = research(draft.dir);
  const others: Record<string, string> = { исходник: r.source };
  for (const o of db
    .prepare("SELECT dir FROM drafts WHERE candidate_id != ?")
    .all(draft.candidate_id) as { dir: string }[]) {
    const name = o.dir.split("/").pop()!;
    const file = join(o.dir, `${name}.html`);
    if (existsSync(file)) others[name] = readFileSync(file, "utf8");
  }
  const lintRes = lint(deps.lintPy, draft.dir, slug, cfg.domain, r.plan.key || slug);
  const checks: Record<string, Check> = {
    lint: { ok: lintRes.ok, detail: lintRes.detail },
    code_ran: {
      ok: !html.includes("[[output"),
      detail: html.includes("[[output") ? "остались места вывода без вывода" : "вывод вставлен",
    },
    images: images(parseArticle(html).files, cfg),
    links: await links(html, cand.url, cfg.domain, deps.head, {
      use: sourceUse(r.plan),
      text: r.source,
      known: r.docs,
    }),
    uniqueness: uniqueness(html, others, cfg.gates.maxShingleShare),
  };
  const issues = await review(deps, html, r.docs, draft.candidate_id);
  const high = issues.filter((i) => i.severity === "high").length;
  checks.review = { ok: high === 0, detail: `замечаний ${issues.length}, high ${high}` };
  const ok = Object.values(checks).every((c) => c.ok);
  const report: GatesReport = { ok, checks, review: issues };
  writeFileSync(join(paths.work, "gates.json"), JSON.stringify(report, null, 1));
  db.prepare("UPDATE candidates SET status = ? WHERE id = ?").run(
    ok ? "ready" : "gate_failed",
    draft.candidate_id,
  );
  return report;
}

type Parsed = ReturnType<typeof parseArticle>;

/** Чем набор файлов и мест вывода правки отличается от прогнанного; пусто — совпадает. */
export function setDrift(before: Parsed, after: Parsed): string {
  const diff = (what: string, a: string[], b: string[]) => {
    const lost = a.filter((x) => !b.includes(x));
    const added = b.filter((x) => !a.includes(x));
    return [
      lost.length ? `${what} пропали ${lost.join(", ")}` : "",
      added.length ? `${what} добавились ${added.join(", ")}` : "",
    ];
  };
  return [
    ...diff("файлы", [...before.files.keys()], [...after.files.keys()]),
    ...diff("места вывода", before.outputs, after.outputs),
  ]
    .filter(Boolean)
    .join("; ");
}

function editIssue(failed: string[]): Issue {
  return {
    severity: "high",
    quote: "",
    problem: `Прошлая правка не применилась: ${failed.join("; ")}.`,
    fix: "Пришли все пары заново. FIND копируй из статьи дословно, символ в символ, и бери столько текста, чтобы фрагмент встречался в файле один раз.",
  };
}

function setIssue(drift: string): Issue {
  return {
    severity: "high",
    quote: "",
    problem: `Прошлая правка изменила набор файлов кода или мест вывода (${drift}). Код уже прогнан на стенде, такую правку принять нельзя.`,
    fix: "Сохрани все блоки кода с теми же именами файлов и все блоки вывода вместе с пометками <!-- output ИМЯ -->. Меняй только текст вокруг них.",
  };
}

/**
 * Одна правка. true — изменился код (нужен новый прогон). `extra` — замечания сверх отчёта проверок.
 */
export async function reviseOnce(
  deps: GateDeps,
  draft: Draft,
  slug: string,
  extra: Issue[] = [],
): Promise<boolean> {
  const paths = draftPaths(draft.dir, slug);
  const html = readFileSync(paths.html, "utf8");
  const meta = readFileSync(paths.meta, "utf8");
  const report = JSON.parse(readFileSync(join(paths.work, "gates.json"), "utf8")) as GatesReport;
  const failedChecks = Object.entries(report.checks)
    .filter(([k, v]) => !v.ok && k !== "review")
    .map(([k, v]) => `- ${k}: ${v.detail}`)
    .join("\n");
  const r = research(draft.dir);
  const { system, user } = render(deps.promptDirs, "revise", deps.cfg, {
    lint: failedChecks || "- нет",
    issues: JSON.stringify(
      [...extra, ...report.review.filter((i) => i.severity !== "low")],
      null,
      1,
    ),
    source: r.source || "(нет)",
    source_url: (
      deps.db.prepare("SELECT url FROM candidates WHERE id = ?").get(draft.candidate_id) as {
        url: string;
      }
    ).url,
    source_use: sourceUse(r.plan),
    docs: r.docs || "(нет)",
    article: html,
    meta_md: meta,
    style_guide: deps.style.styleGuide,
    content_rules: deps.style.contentRules,
    sat_delta: deps.style.satDelta,
  });
  const before = parseArticle(html);
  let next = { article: html, meta };
  let after = before;
  let problem: Issue | null = null;
  // Модель иногда теряет блок кода, пометку <!-- output ИМЯ --> или цитирует фрагмент не дословно:
  // один повтор с прямым замечанием. Пары повтора снова применяются к исходной статье.
  for (let attempt = 0; attempt < 2; attempt++) {
    const u = problem ? `${user}\n\n${JSON.stringify([problem], null, 1)}` : user;
    const answer = await deps.llm.ask("revise", system, u, ARTICLE_MAX_TOKENS, draft.candidate_id);
    problem = null;
    let edits: Edit[] = [];
    try {
      edits = parseEdits(answer);
    } catch (err) {
      problem = editIssue([(err as Error).message]);
    }
    if (!problem) {
      const applied = applyEdits({ article: html, meta }, edits);
      if (applied.failed.length) problem = editIssue(applied.failed);
      else {
        next = applied;
        after = parseArticle(next.article);
        const drift = setDrift(before, after);
        if (drift) {
          problem = setIssue(drift);
          writeFileSync(join(paths.work, "revise.rejected.html"), next.article);
        }
      }
    }
    if (!problem) break;
    writeFileSync(join(paths.work, "revise.rejected.txt"), answer);
  }
  if (problem) throw new Error(`правка не принята: ${problem.problem}`);
  // Вывод — только настоящий: возвращаем прежние блоки вывода, что бы ни написала модель.
  const fixed = setOutputs(next.article, outputsOf(html));
  writeFileSync(paths.html, fixed.endsWith("\n") ? fixed : `${fixed}\n`);
  writeFileSync(paths.meta, next.meta.endsWith("\n") ? next.meta : `${next.meta}\n`);
  return [...before.files].some(([n, b]) => after.files.get(n) !== b);
}

/** Отпечаток прогона стенда: align.json действителен только для того прогона, после которого сделан. */
function runHash(dir: string): string {
  const p = join(dir, ".work", "run.json");
  return existsSync(p)
    ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)
    : "";
}

/** Сверка сделана после последнего прогона стенда (ADR 0003). Новый прогон — сверка заново. */
export function aligned(dir: string): boolean {
  const p = join(dir, ".work", "align.json");
  if (!existsSync(p)) return false;
  const run = runHash(dir);
  return run !== "" && (JSON.parse(readFileSync(p, "utf8")) as { run?: string }).run === run;
}

export type AlignResult = { run: string; ok: boolean; edits: number; detail: string };

/**
 * Сверка текста с реальным выводом (ADR 0003): один вызов LLM после удачного стенда, пары замен как у
 * правки. Код и вывод заморожены: правка, что трогает файлы кода или места вывода, не применяется,
 * статья идёт в проверки как есть. Итог — `.work/align.json` с отпечатком прогона.
 */
export async function align(deps: GateDeps, draft: Draft, slug: string): Promise<AlignResult> {
  const paths = draftPaths(draft.dir, slug);
  const html = readFileSync(paths.html, "utf8");
  const meta = readFileSync(paths.meta, "utf8");
  const save = (r: Omit<AlignResult, "run">): AlignResult => {
    const res = { run: runHash(draft.dir), ...r };
    writeFileSync(join(paths.work, "align.json"), JSON.stringify(res, null, 1));
    return res;
  };
  const before = parseArticle(html);
  if (!before.outputs.length) return save({ ok: true, edits: 0, detail: "мест вывода нет" });
  const { system, user } = render(deps.promptDirs, "align", deps.cfg, {
    docs: research(draft.dir).docs || "(нет)",
    article: html,
    meta_md: meta,
    style_guide: deps.style.styleGuide,
    content_rules: deps.style.contentRules,
    sat_delta: deps.style.satDelta,
  });
  const answer = await deps.llm.ask("align", system, user, ARTICLE_MAX_TOKENS, draft.candidate_id);
  if (!/=====FIND (ARTICLE|META)=====/.test(answer)) {
    return save({ ok: true, edits: 0, detail: "текст уже совпадает с выводом" });
  }
  const reject = (detail: string) => {
    writeFileSync(join(paths.work, "align.rejected.txt"), answer);
    return save({ ok: false, edits: 0, detail });
  };
  let edits: Edit[];
  try {
    edits = parseEdits(answer);
  } catch (err) {
    return reject((err as Error).message);
  }
  const applied = applyEdits({ article: html, meta }, edits);
  if (applied.failed.length) return reject(`пары не применились: ${applied.failed.join("; ")}`);
  const after = parseArticle(applied.article);
  const drift = setDrift(before, after);
  if (drift) return reject(drift);
  const code = [...before.files].filter(([n, b]) => after.files.get(n) !== b).map(([n]) => n);
  if (code.length) return reject(`правка меняет код ${code.join(", ")}`);
  const fixed = setOutputs(applied.article, outputsOf(html));
  writeFileSync(paths.html, fixed.endsWith("\n") ? fixed : `${fixed}\n`);
  writeFileSync(paths.meta, applied.meta.endsWith("\n") ? applied.meta : `${applied.meta}\n`);
  return save({ ok: true, edits: edits.length, detail: `пар ${edits.length}` });
}

/** Стенд и, если он прошёл, сверка текста с выводом. true — стенд прошёл. */
async function standAligned(deps: GateDeps, draft: Draft, slug: string): Promise<boolean> {
  if (!(await checkDraft(deps, draft, slug))) return false;
  await align(deps, draft, slug);
  return true;
}

function standOk(dir: string): boolean {
  const p = join(dir, ".work", "run.json");
  return existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as { ok?: boolean }).ok === true;
}

/** Переписывания черновика за все прогоны: без потолка gate_failed переписывался бы каждую неделю. */
export function revisionsDone(db: Db, id: number): number {
  return (
    db
      .prepare("SELECT count(*) AS n FROM llm_calls WHERE stage = 'revise' AND candidate_id = ?")
      .get(id) as { n: number }
  ).n;
}

/**
 * До gates.maxRevisions кругов «переписать → (прогон) → проверки» за прогон и не больше
 * gates.maxRevisionsTotal за все прогоны. true — статья прошла.
 */
export async function finish(deps: GateDeps, draft: Draft, slug: string): Promise<boolean> {
  // Код не прошёл стенд в прошлый раз: стенд могли починить с тех пор, а правка текста его не перезапустит.
  if (!standOk(draft.dir)) {
    if (!(await standAligned(deps, draft, slug))) return false;
    if ((await gate(deps, draft, slug)).ok) return true;
  }
  for (
    let i = 0;
    i < deps.cfg.gates.maxRevisions &&
    revisionsDone(deps.db, draft.candidate_id) < deps.cfg.gates.maxRevisionsTotal;
    i++
  ) {
    if (await reviseOnce(deps, draft, slug)) {
      if (!(await standAligned(deps, draft, slug))) return false;
    }
    if ((await gate(deps, draft, slug)).ok) return true;
  }
  return false;
}

/** Замечание первого круга переделки: прежний текст мог строиться на анонсе из ленты, а не на статье. */
export const REWORK_ISSUE: Issue = {
  severity: "high",
  quote: "",
  problem:
    "Текст мог быть написан без полного текста исходника. Теперь исходник прочитан целиком и передан ниже.",
  fix: "Сверь с исходником всё, что статья о нём говорит. Неверное исправь, важное из исходника добавь. Фразы о подготовке статьи и о том, что не удалось прочитать, убери.",
};

/**
 * Переделка готового черновика по заново прочитанному исходнику (`sat rework`, команда автора).
 * Правка идёт всегда, даже если проверки чистые: они не сравнивают текст с исходником. Потолок
 * gates.maxRevisionsTotal здесь не действует, но прежние правки в журнале остаются, поэтому недельный
 * прогон не докупает новые круги. Круг переделки ограничен gates.maxRevisions. true — статья прошла.
 */
export async function rework(deps: GateDeps, draft: Draft, slug: string): Promise<boolean> {
  // Стенд мог не пройти раньше из-за самого стенда. Новый провал не отменяет правку текста.
  if (!standOk(draft.dir)) await standAligned(deps, draft, slug);
  else if (!aligned(draft.dir)) await align(deps, draft, slug);
  await gate(deps, draft, slug); // gates.json мог устареть с прошлого релиза, правке нужны свежие провалы
  for (let i = 0; i < deps.cfg.gates.maxRevisions; i++) {
    if (await reviseOnce(deps, draft, slug, i === 0 ? [REWORK_ISSUE] : [])) {
      if (!(await standAligned(deps, draft, slug))) return false;
    }
    if ((await gate(deps, draft, slug)).ok) return true;
  }
  return false;
}

export function slugOf(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").pop()!;
}
