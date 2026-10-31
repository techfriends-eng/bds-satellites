#!/usr/bin/env bash
# Деплой сайта-спутника на progon (handbook standards/07, отклонение — ADR сайта: на progon нет
# MCP-шлюза, вызов по ssh с wsa100). Запуск в клоне сайта от его пользователя:
#   ssh progon 'sudo -u bds-sat-<site> -H bash -lc "cd /opt/bds-sat-<site> && node_modules/bds-satellites/ops/deploy-site.sh"'
# Первый деплой — ops/install-site.sh сайта. Шаги: чистое дерево → ff-only → npm install (сборка пакета
# по prepare) → образ визуализации → selfcheck → smoke (sat sync пишет журнал хаба).
set -euo pipefail
site_dir=$(pwd)
[ -z "$(git status --porcelain)" ] || { echo "грязное дерево в $site_dir — отказ без изменений" >&2; exit 1; }
git fetch -q
git merge -q --ff-only '@{u}' || { echo "fast-forward невозможен — отказ" >&2; exit 1; }
npm install --no-audit --no-fund
node_modules/bds-satellites/ops/build-visuals.sh
set -a
# shellcheck source=/dev/null  # env сайта на хосте, имя по каталогу клона
. "/etc/$(basename "$site_dir").env"
set +a
node_modules/bds-satellites/ops/selfcheck.sh
node node_modules/bds-satellites/dist/cli.js sync
echo "деплой: $(git log --oneline -1), bds-satellites $(cat node_modules/bds-satellites/VERSION)"
