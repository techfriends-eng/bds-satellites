#!/usr/bin/env bash
# Тонкий репо нового сайта-спутника из templates/site (ADR 0001): новый сайт — это конфиг, а не сборка.
#   ops/new-site.sh <site> <domain> <day> <каталог-клона>
# Пример: ops/new-site.sh spark spark-school.ru wed ~/work/bds-sat-spark
# Новый сайт — все файлы шаблона. Существующий сайт — обновляются только служебные (ops/, deploy/, CI,
# хуки, тесты, конфиги линтеров); документы, конфиг, package.json и VERSION сайта не трогаются: в них
# его история и закреплённая версия пакета.
set -euo pipefail
site=${1:?site}
domain=${2:?domain}
day=${3:?день прогона: mon..sun}
dest=${4:?каталог клона}
PKG="$(cd "$(dirname "$0")/.." && pwd)"
version=$(cat "$PKG/VERSION")
day_uc="$(echo "${day:0:1}" | tr '[:lower:]' '[:upper:]')${day:1}"
today=$(date +%F)

mkdir -p "$dest"
(cd "$PKG/templates/site" && find . -type f) | while read -r rel; do
  out="$dest/${rel//__SITE__/$site}"
  case "$rel" in
    ./ops/* | ./deploy/* | ./.github/* | ./.githooks/* | ./tests/* | ./.gitleaks.toml | ./.gitignore | ./.prettier*) ;;
    *)
      if [ -e "$out" ]; then
        echo "оставлен $out"
        continue
      fi
      ;;
  esac
  mkdir -p "$(dirname "$out")"
  sed -e "s/__SITE__/$site/g" -e "s/__DOMAIN__/$domain/g" -e "s/__DAY_UC__/$day_uc/g" -e "s/__DAY__/$day/g" \
      -e "s/__PKG_VERSION__/$version/g" -e "s/__DATE__/$today/g" "$PKG/templates/site/$rel" > "$out"
  if [ -x "$PKG/templates/site/$rel" ]; then chmod +x "$out"; fi
done
echo "готово: $dest (bds-satellites v$version). Дальше: config/site.yaml, npm install, npx prettier --write ., npm run gate, коммит."
