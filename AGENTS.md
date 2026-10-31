# AGENTS.md — bds-satellites

Правила для ИИ-агентов в этом репо. Общие стандарты — [handbook](https://github.com/techfriends-eng/handbook):
перед изменением прочитай `principles.md` и нужный `gotchas/` (особенно `llm.md`, `wordpress.md`).

## Гейт

```sh
npm run gate
```

Работает без `/etc/bds-sat-*.env`, без сети и без БД. Без пайпов, которые прячут код возврата.

## Правила проекта

- Перед новым модулем проверь `@techfriends-eng/toolkit`: ingest, filter, llm, wp, db, config уже там.
  Расширение toolkit — отдельный релиз toolkit с тестами, затем подъём тега здесь.
- Изменение поведения в том же коммите обновляет CHANGELOG, RUNBOOK и, если затронуто,
  `site-template/` (тонкие репо сайтов получают это через `ops/new-site.sh` или ручной перенос).
- Секреты — только в `/etc/bds-sat-<site>.env` на progon. В коде — `readSecret`.
- Релиз: CHANGELOG, `VERSION` и `package.json`, тег `vX.Y.Z`. Сайты поднимают тег сами.
- Публикация в WP только черновиком (`publish.status: draft`) до решения автора.
- Конвейер не пишет в Telegram: итоги — журнал хаба, сбои — тревоги мониторинга в LOGS.

## Чего не трогать

- `style/upstream/` — копия правил bds-article. Обновление — новая копия с коммитом исходника в шапке,
  отличия спутников — только в `style/sat-delta.md`.
- `lint/sat_lint.py` — форк `bds-wiki-articles/wiki_lint.py`. Правки ограничены профилем `sat`; общие
  проверки меняются в исходнике, потом переносятся сюда.
- `visuals/*.json`, `visuals/Dockerfile` — параметры рендера из wiki_visualizer с причинами в исходнике.
- Код bds-article, wiki_lint, wiki_visualizer, Stack Radar — рабочие системы: форк да, правка на месте — нет.
