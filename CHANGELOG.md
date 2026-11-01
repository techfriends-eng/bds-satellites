# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

## [0.1.9] — 2026-11-01

### Исправлено
- `run-site.sh` вне юнита отказывается (код 2): из ssh lock попадал в `/tmp`, сторож простоя его не видел и
  выключал progon посреди прогона. Ручной прогон в RUNBOOK сайта §9 — через юнит и `systemctl set-environment`.
- `new-site.sh` подсказывает `prettier --write`: таблицы RUNBOOK и CHANGELOG после подстановки имени сайта
  не проходили `npm run lint`.

## [0.1.8] — 2026-11-01

### Исправлено
- `bootstrap-site.sh` пишет значения env в двойных кавычках: пароль приложения WordPress с пробелами
  ломал `source` в `deploy-site.sh` («command not found»).

## [0.1.7] — 2026-11-01

### Исправлено
- Установщик сайта ставит Node 22 из репозитория NodeSource, как на auto08: на progon Node не было,
  а в Ubuntu 24.04 только 18 (пакету нужен 22+ ради `node:sqlite`). Деплой падал на `npm: command not found`.

## [0.1.6] — 2026-11-01

### Исправлено
- `new-site.sh` на существующем сайте обновляет только служебные файлы; документы, конфиг,
  `package.json` и `VERSION` сайта не перезаписываются (повторный запуск сбрасывал CHANGELOG и даты ADR).

## [0.1.5] — 2026-11-01

### Исправлено
- Установщик сайта: ключ хоста GitHub — keyscan с повторами и сверка с опубликованным отпечатком,
  пустой ответ — ошибка (раньше молча пустой `known_hosts` и «Host key verification failed» на клоне);
  `.ssh/config` с правами 600.

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
