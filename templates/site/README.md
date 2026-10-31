# bds-sat-__SITE__

handbook: v0.1

Автоконтент для __DOMAIN__: раз в неделю конвейер [bds-satellites](https://github.com/techfriends-eng/bds-satellites)
на progon берёт 1–2 материала из лент сайта, пишет статью шире исходника с практикой на стенде и
заданиями, проверяет её и кладёт черновиком в WordPress. Итоги — BDS Хаб, раздел «Спутники».

Здесь только то, что принадлежит сайту: `config/site.yaml` (ленты, темы, курсы, модели, стенд, день
прогона), `prompts/site/` (дополнения к общим промптам), юниты и `env.example` в `deploy/`. Код конвейера —
пакет `bds-satellites`, версия закреплена тегом в `package.json` (ADR 0001 bds-satellites).

```sh
npm install && npm run gate      # конфиг разбирается
```

- [RUNBOOK.md](RUNBOOK.md) — эксплуатация сайта; общая часть — RUNBOOK bds-satellites.
- [AGENTS.md](AGENTS.md) — правила для ИИ-агентов.
- [docs/adr/](docs/adr/) — решения сайта: деплой по ssh, без typecheck.
