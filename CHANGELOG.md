# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

## [0.1.4] — 2026-11-01

### Добавлено
- `ops/bootstrap-site.sh <site>` — первая установка сайта на progon одной командой автора с wsa100:
  установщик, read-only deploy key, секреты из `~/.config/sat/` через stdin, деплой.

## [0.1.3] — 2026-10-31

### Исправлено
- CI шаблона сайта: убран шаг с `secrets` в условии `if:` — GitHub отвергал весь workflow. Пакет
  публичный, токен для установки не нужен.

## [0.1.2] — 2026-10-31

### Добавлено
- Шаблон сайта: тесты конфига `tests/*.test.mjs` (домен, курсы, источники, модели), `lint` (prettier),
  обёртка `ops/selfcheck.sh` с окружением сайта, ADR 0002 «без typecheck» (в репо сайта нет кода).

## [0.1.1] — 2026-10-31

### Изменено
- Шаблон тонкого репо сайта переехал в `templates/site/` (соглашение handbook: таймеры шаблонов не
  считаются задачами пакета в `audit.sh`). `ops/new-site.sh` берёт его оттуда.

## [0.1.0] — 2026-10-31

### Добавлено
- Конвейер на TS по ADR 0001 вместо прототипа на Python (эталон поведения — приватный
  bds-satellites-prototype): сбор лент (toolkit/ingest), дедуп по URL и simhash, сверка с bigdataschool.ru и
  Stack Radar, предотбор (toolkit/filter), отбор и генерация через OpenRouter (toolkit/llm 0.6.0,
  `completeDetailed`), прогон кода на стенде с починкой, проверки и переписывание по реальному выводу,
  схемы и превью, черновик в WordPress (toolkit/wp), журнал в базу sat для BDS Хаба.
- Форк правил bds-article (Style Guide V10-Blog, B5) и `wiki_lint.py` с профилем `sat`: статья сразу в
  WP-HTML, без двоеточий в заголовках, `<code>`, длинного тире; CTA ссылкой вместо `cbanner`.
- Форк рендера wiki_visualizer: Mermaid в палитре, превью Gemini Image, чистка метаданных exiftool.
- Эксплуатация: `run-site.sh` (день, PAUSE, память, lock для сторожа простоя), `deploy-site.sh`,
  `selfcheck.sh`, сторож `checks.d/bds-satellites.sh` для auto08, шаблон тонкого репо сайта и `new-site.sh`.
