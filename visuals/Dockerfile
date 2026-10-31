# Форк techfriends-eng/bds-wiki-visualizer@2dd520b (Dockerfile): mermaid-cli в headless Chromium.
# Добавлено для спутников: exiftool — чистка метаданных картинок (EXIF/XMP/C2PA) вместо сервиса
# watermarks-remover на auto08 (ADR 0001: без нового сетевого пути progon → auto08).
# Тег образа — версия bds-satellites: ops/build-visuals.sh собирает bds-sat-visuals:$(cat VERSION).
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick libimage-exiftool-perl nodejs npm chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# fonts-liberation — метрическая замена Arial: схемы задают fontFamily:'Arial', без неё подписи
# наезжают друг на друга. HOME=/tmp — контейнер идёт с --user хоста, без записи в /etc/passwd
# Chromium иначе падает на crashpad (исходник, RUNBOOK §4 wiki_visualizer).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOME=/tmp
RUN npm install -g @mermaid-js/mermaid-cli@11.4.2

COPY image_spec.json mermaid_theme_override.json puppeteer-config.json /visuals/
WORKDIR /data
