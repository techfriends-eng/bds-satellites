# bds-satellites

handbook: v0.1

Общий конвейер автоконтента сайтов-спутников bigdataschool.ru (kafka-school.ru, spark-school.ru,
python-school.ru). Раз в неделю для каждого сайта: сбор лент → дедуп (свои, bigdataschool.ru, Stack Radar) →
отбор → статья шире исходника по Style Guide блога → прогон кода на стенде → проверки (линтер, смысловая) →
переписывание по реальному выводу → схемы и превью → черновик в WordPress → журнал в BDS Хаб.
Архитектура и причины — [ADR 0001](docs/adr/0001-satellites-architecture.md).

Сайт — тонкий репо `bds-sat-<site>` (конфиг, свои дополнения к промптам, юниты), этот пакет закреплён в нём
тегом. Новый сайт: `ops/new-site.sh <site> <domain> <day> <клон>`.

## Быстрый старт

```sh
npm install
npm run gate          # test:unit, test:lint (эталоны линтера), typecheck, lint
SAT_SITE_DIR=../bds-sat-kafka SAT_STATE_DIR=/tmp/sat scripts/sat.mjs collect
```

## Что где

| Каталог | Что |
|---|---|
| `src/lib/` | домены: `sources`, `dedup`, `select`, `research`, `generate`, `stand`, `gates`, `visuals`, `publish`, `journal`; `pipeline.ts` — сборка |
| `style/` | форк правил bds-article (`upstream/`, не правится) и отличия спутников (`sat-delta.md`) |
| `lint/` | форк `wiki_lint.py` с профилем `sat` и эталонными тестами |
| `prompts/` | промпты этапов; сайт дописывает свои в `prompts/site/` своего репо |
| `visuals/` | форк рендера wiki_visualizer: Dockerfile, конфиги Mermaid |
| `ops/` | `run-site.sh` (юнит сайта), `deploy-site.sh`, `selfcheck.sh`, `new-site.sh`, `checks.d/` для auto08 |
| `site-template/` | шаблон тонкого репо сайта |

- [RUNBOOK.md](RUNBOOK.md) — эксплуатация.
- [AGENTS.md](AGENTS.md) — правила для ИИ-агентов.
- [CHANGELOG.md](CHANGELOG.md).
