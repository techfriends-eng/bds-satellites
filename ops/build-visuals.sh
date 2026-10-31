#!/usr/bin/env bash
# Сборка образа рендера схем и превью (visuals/Dockerfile) с тегом версии пакета. Запускает deploy-site.sh.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
tag="bds-sat-visuals:$(cat "$PKG/VERSION")"
if docker image inspect "$tag" >/dev/null 2>&1; then
  echo "$tag уже есть"
else
  docker build -t "$tag" "$PKG/visuals"
fi
