#!/usr/bin/env bash
# Готовность окружения сайта-спутника на progon. Выход 0 — всё готово. Запуск от пользователя сайта:
#   sudo -u bds-sat-<site> -H bash -lc 'set -a; . /etc/bds-sat-<site>.env; set +a; /opt/bds-sat-<site>/node_modules/bds-satellites/ops/selfcheck.sh'
set -euo pipefail

PKG="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "OK   $name"
  else
    echo "FAIL $name"
    fail=1
  fi
}

check "node 22+" node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'
check "python3 (линтер)" python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
check "docker доступен" docker info
check "образ bds-sat-visuals:$(cat "$PKG/VERSION")" docker image inspect "bds-sat-visuals:$(cat "$PKG/VERSION")"
for v in SAT_SITE_DIR SAT_STATE_DIR OPENROUTER_API_KEY WP_URL WP_USER WP_APP_PASSWORD SAT_DB_URL; do
  check "$v задан" test -n "${!v:-}"
done
check "каталог состояния пишется" test -w "${SAT_STATE_DIR:-/nonexistent}"
check "конфиг сайта читается" node "$PKG/dist/cli.js" sync --check-config
# Ключи читает node из окружения: в команде их нет ни в виде аргументов, ни в истории оболочки.
check "OpenRouter: ключ принят" node -e '
  fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: "Bearer " + process.env.OPENROUTER_API_KEY } })
    .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
check "WordPress: вход пользователя" node -e '
  const auth = Buffer.from(process.env.WP_USER + ":" + process.env.WP_APP_PASSWORD).toString("base64");
  fetch(process.env.WP_URL + "/wp-json/wp/v2/users/me", { headers: { authorization: "Basic " + auth } })
    .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'

exit "$fail"
