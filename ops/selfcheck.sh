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
# Git-зависимость не двигается в lock сайта вместе с пином пакета: сайты жили на toolkit 0.6.0 при пине v0.6.2.
check "toolkit той версии, что требует пакет" node -e '
  const { existsSync, readFileSync } = require("node:fs");
  const pkg = process.argv[1];
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const want = read(pkg + "/package.json").dependencies["@techfriends-eng/toolkit"].split("#v")[1];
  const near = pkg + "/node_modules/@techfriends-eng/toolkit/package.json";
  const got = read(existsSync(near) ? near : pkg + "/../@techfriends-eng/toolkit/package.json").version;
  process.exit(got === want ? 0 : 1);' "$PKG"
check "docker доступен" docker info
check "образ bds-sat-visuals:$(cat "$PKG/VERSION")" docker image inspect "bds-sat-visuals:$(cat "$PKG/VERSION")"
for v in SAT_SITE_DIR SAT_STATE_DIR OPENROUTER_API_KEY WP_URL WP_USER WP_APP_PASSWORD SAT_DB_URL; do
  check "$v задан" test -n "${!v:-}"
done
check "каталог состояния пишется" test -w "${SAT_STATE_DIR:-/nonexistent}"
check "конфиг сайта читается" node "$PKG/dist/cli.js" sync --check-config
check "brand сходится с главной сайта" node "$PKG/dist/cli.js" brand-check
# Ключи читает node из окружения: в команде их нет ни в виде аргументов, ни в истории оболочки.
check "OpenRouter: ключ принят" node -e '
  fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: "Bearer " + process.env.OPENROUTER_API_KEY } })
    .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
check "WordPress: вход пользователя" node -e '
  const auth = Buffer.from(process.env.WP_USER + ":" + process.env.WP_APP_PASSWORD).toString("base64");
  fetch(process.env.WP_URL + "/wp-json/wp/v2/users/me", { headers: { authorization: "Basic " + auth } })
    .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'

exit "$fail"
