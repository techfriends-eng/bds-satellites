# visuals

Форк конфигурации рендера из `techfriends-eng/bds-wiki-visualizer@2dd520b` (`config/`, `Dockerfile`):
`image_spec.json` (1200×800, палитра), `mermaid_theme_override.json` (шрифт 26px, цвет подписей дуг),
`puppeteer-config.json`. Почему именно эти параметры — комментарии `scripts/lib/mermaid_render.sh`
исходника: scale 3, шрифт относительно ширины, контраст подписей на оранжевом. Файлы здесь не правятся
без причины в комментарии коммита; обновление из исходника — новая копия с новым коммитом.
