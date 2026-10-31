# AGENTS.md — bds-sat-__SITE__

Тонкий репо сайта-спутника. Стандарты — [handbook](https://github.com/techfriends-eng/handbook), код
конвейера — [bds-satellites](https://github.com/techfriends-eng/bds-satellites) (там же правила текста и линтер).

## Гейт

```sh
npm install && npm run gate
```

## Правила

- Код конвейера здесь не пишется и не копируется. Нужна правка поведения — в bds-satellites, затем
  отдельный коммит здесь с подъёмом тега в `package.json` и прогоном гейта.
- Здесь меняются только `config/site.yaml`, `prompts/site/*.md`, `deploy/`, документы.
- Секреты — только в `/etc/bds-sat-__SITE__.env` на progon, в репо — `deploy/*.env.example`.
- Деплой — RUNBOOK §6 после push в `main`; ADR 0001 этого репо объясняет, почему по ssh.
- Публикация в WP только черновиком (`publish.status: draft`) до решения автора.

## Чего не трогать

- `deploy/*.service`: `RuntimeDirectory` и lock в `run-site.sh` держат сервер включённым, пока идёт прогон.
