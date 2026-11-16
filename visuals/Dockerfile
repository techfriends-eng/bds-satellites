# Форк techfriends-eng/bds-wiki-visualizer@29b677d (Dockerfile): mermaid-cli в headless Chromium.
# Сверено 2026-11-16: база node:22-bookworm-slim и mermaid-cli 12.2.0 — как в источнике, рендер схем у wiki и
# спутников одной версией. Не берём из источника: стадию deps с toolkit (рендер спутников зовёт toolkit на хосте,
# в образе только mmdc), bash, jq, curl и postgresql-client (журнал wiki).
# Добавлено для спутников: exiftool — чистка метаданных картинок (EXIF/XMP/C2PA) вместо сервиса
# watermarks-remover на auto08 (ADR 0001: без нового сетевого пути progon → auto08).
# Тег образа — версия bds-satellites: ops/build-visuals.sh собирает bds-sat-visuals:$(cat VERSION).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick libimage-exiftool-perl chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# fonts-liberation — метрическая замена Arial: схемы задают fontFamily:'Arial', без неё подписи
# наезжают друг на друга. HOME=/tmp — контейнер идёт с --user хоста, без записи в /etc/passwd
# Chromium иначе падает на crashpad (исходник, RUNBOOK §4 wiki_visualizer).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOME=/tmp
RUN npm install -g @mermaid-js/mermaid-cli@12.2.0

COPY image_spec.json mermaid_theme_override.json puppeteer-config.json /visuals/
WORKDIR /data
