#!/usr/bin/env bash
# Имя сайта и пути подставляются на wsa100 и уходят на progon готовыми командами.
# shellcheck disable=SC2029
# Первая установка сайта-спутника на progon. Запускает автор на wsa100 в обычном терминале:
#   ~/work/bds-satellites/ops/bootstrap-site.sh <site>          например: … kafka
# Идемпотентно, шаги:
#   1. progon включается (stand_progon.sh up);
#   2. install-site.sh сайта: пользователь bds-sat-<site>, deploy key, /var/lib, /etc env из примера, юниты, сторож;
#   3. read-only deploy key добавляется в репо сайта (gh), клон в /opt;
#   4. секреты из ~/.config/sat/ уходят в /etc/bds-sat-<site>.env через stdin — в выводе их нет;
#   5. деплой: npm install (пакет по тегу), образ визуализации, selfcheck, smoke (журнал хаба).
# Источник секретов на wsa100 (права 600): <site>-openrouter.env, <site>-wp.env, sat-db.env, stackradar-ro.env.
set -euo pipefail
site=${1:?site, например kafka}
U="bds-sat-$site"
REPO="techfriends-eng/$U"
SITE_DIR="${SITE_DIR:-$HOME/work/$U}"
CFG="$HOME/.config/sat"
STAND="${STAND:-$HOME/work/bds-wiki-articles/stand_progon.sh}"

echo "== 1. progon"
"$STAND" up | tail -1

echo "== 2. установщик сайта"
ssh progon "rm -rf /tmp/$U && mkdir -p /tmp/$U"
scp -q "$SITE_DIR/ops/install-site.sh" "$SITE_DIR"/deploy/"$U".{service,timer,env.example} "progon:/tmp/$U/"
if ! ssh progon "bash /tmp/$U/install-site.sh" | tee /tmp/"$U"-install.log; then
  echo "== 3. deploy key в $REPO"
  pub=$(mktemp)
  ssh progon "sudo cat /var/lib/$U/.ssh/github-$U.pub" >"$pub"
  gh repo deploy-key add "$pub" --repo "$REPO" --title "progon $U (read-only)"
  rm -f "$pub"
  ssh progon "bash /tmp/$U/install-site.sh" | tail -3
fi

echo "== 4. секреты в /etc/$U.env"
# Пути — из примера репо сайта, секреты — из файлов wsa100. Файл пишется целиком через stdin, 640 root:$U.
{
  grep -E '^(SAT_SITE_DIR|SAT_STATE_DIR|SAT_STAND_BASE|NODE_OPTIONS)=' "$SITE_DIR/deploy/$U.env.example"
  grep -h '^OPENROUTER_API_KEY=' "$CFG/$site-openrouter.env"
  grep -hE '^WP_(URL|USER|APP_PASSWORD)=' "$CFG/$site-wp.env"
  grep -h '^SAT_DB_URL=' "$CFG/sat-db.env"
  grep -h '^STACKRADAR_RO_URL=' "$CFG/stackradar-ro.env"
} | ssh progon "sudo install -m 640 -o root -g $U /dev/stdin /etc/$U.env && sudo grep -c = /etc/$U.env | sed 's/^/переменных: /'"

echo "== 5. деплой"
ssh progon "sudo -u $U -H bash -lc 'cd /opt/$U && node_modules/bds-satellites/ops/deploy-site.sh 2>/dev/null || (npm install --no-audit --no-fund && node_modules/bds-satellites/ops/deploy-site.sh)'"
echo "готово. Полный прогон вручную: RUNBOOK сайта §9 (SAT_FORCE=1)."
