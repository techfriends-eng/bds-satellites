#!/usr/bin/env bash
# Сборка образа рендера схем и превью (visuals/Dockerfile) с тегом версии пакета. Запускает deploy-site.sh.
# После сборки удаляет старые теги bds-sat-visuals: каждый деплой давал новый тег по ~0.6 ГБ уникально,
# и к 2026-11-14 на progon их было девять (диск 100%). Теги, на которых стоят сайты (VERSION в
# /opt/bds-sat-*/node_modules/bds-satellites), не трогаются: сайты деплоятся по одному и могут стоять на разных версиях.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
version="$(cat "$PKG/VERSION")"
tag="bds-sat-visuals:$version"
if docker image inspect "$tag" >/dev/null 2>&1; then
  echo "$tag уже есть"
else
  docker build -t "$tag" "$PKG/visuals"
fi

keep=" $version "
for f in /opt/bds-sat-*/node_modules/bds-satellites/VERSION; do
  [ -e "$f" ] || continue
  [ -r "$f" ] || { echo "нет доступа к $f — старые теги не чищу"; exit 0; }
  keep+="$(cat "$f") "
done
docker image ls bds-sat-visuals --format '{{.Tag}}' | while read -r t; do
  case "$keep" in *" $t "*) continue ;; esac
  docker rmi "bds-sat-visuals:$t" >/dev/null && echo "удалён старый тег bds-sat-visuals:$t"
done
docker image prune -f >/dev/null
