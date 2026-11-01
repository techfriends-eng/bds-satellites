#!/usr/bin/env bash
# Первая установка сайта на progon (RUNBOOK §10). Запуск на progon от ubuntu (sudo), из любого места:
#   scp ops/install-site.sh deploy/* progon:/tmp/bds-sat-__SITE__/ (с wsa100), затем на progon: bash /tmp/bds-sat-__SITE__/install-site.sh
# Идемпотентно: Node 22 (NodeSource), пользователь в группе docker, read-only deploy key репо сайта (handbook
# gotchas/hosting.md#ro-deploy-key; пакет bds-satellites публичный, ставится без ключа), клон в /opt,
# /var/lib, /etc env из .env.example, юниты, правка сторожа простоя (lock прогона спутника — занятость).
set -euo pipefail
SITE=__SITE__
U="bds-sat-$SITE"
HOME_U="/var/lib/$U"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Юниты и env.example — в ../deploy клона или рядом со скриптом (копия в /tmp при первой установке).
DEP="$HERE/../deploy"; [ -d "$DEP" ] || DEP="$HERE"

# Node 22+ (node:sqlite) из репозитория NodeSource, как на auto08: в Ubuntu 24.04 только Node 18.
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  printf 'Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSuites: nodistro\nComponents: main\nArchitectures: amd64\nSigned-By: /usr/share/keyrings/nodesource.gpg\n' \
    | sudo tee /etc/apt/sources.list.d/nodesource.sources >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq nodejs
fi
node -v

id "$U" >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir "$HOME_U" --shell /bin/bash "$U"
sudo usermod -aG docker "$U"
sudo install -d -o "$U" -g "$U" -m 750 "$HOME_U" "$HOME_U/runs"
sudo install -d -o "$U" -g "$U" -m 700 "$HOME_U/.ssh"

key() { # алиас ssh, репо
  local alias=$1 repo=$2 file="$HOME_U/.ssh/$1"
  sudo -u "$U" test -e "$file" || sudo -u "$U" ssh-keygen -q -t ed25519 -N '' -C "progon $U $repo" -f "$file"
  if ! sudo -u "$U" grep -q "Host $alias" "$HOME_U/.ssh/config" 2>/dev/null; then
    printf 'Host %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$alias" "$file" \
      | sudo -u "$U" tee -a "$HOME_U/.ssh/config" >/dev/null
  fi
  sudo chmod 600 "$HOME_U/.ssh/config" # ssh отвергает config, доступный группе на запись
  echo "deploy key $repo (read-only): $(sudo cat "$file.pub")"
}
key github-$U "techfriends-eng/$U"
# Ключ хоста GitHub: keyscan с повторами и сверка с опубликованным отпечатком (docs.github.com,
# «GitHub's SSH key fingerprints»). Пустой ответ — ошибка: молча пустой known_hosts давал
# «Host key verification failed» на клоне (первая установка kafka, 2026-11-01).
GITHUB_ED25519=SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
hostkey=""
for _ in 1 2 3; do
  hostkey=$(ssh-keyscan -t ed25519 github.com 2>/dev/null | grep -v '^#' || true)
  [ -n "$hostkey" ] && break
  sleep 5
done
[ -n "$hostkey" ] || { echo "ssh-keyscan github.com не ответил — проверь сеть progon" >&2; exit 1; }
fp=$(ssh-keygen -lf - <<<"$hostkey" | awk '{print $2}')
[ "$fp" = "$GITHUB_ED25519" ] || { echo "отпечаток github.com $fp не совпал с опубликованным" >&2; exit 1; }
echo "$hostkey" | sudo -u "$U" tee "$HOME_U/.ssh/known_hosts" >/dev/null

if [ ! -d "/opt/$U/.git" ]; then
  sudo install -d -o "$U" -g "$U" -m 755 "/opt/$U"
  sudo -u "$U" git clone -q "git@github-$U:techfriends-eng/$U.git" "/opt/$U" || {
    echo "клон не удался: добавь deploy key репо выше (gh repo deploy-key add) и запусти снова" >&2
    exit 1
  }
fi
if [ ! -e "/etc/$U.env" ]; then
  sudo install -m 640 -o root -g "$U" "$DEP/$U.env.example" "/etc/$U.env"
  echo "заполни секреты в /etc/$U.env"
fi
sudo install -m 644 "$DEP/$U.service" "$DEP/$U.timer" /etc/systemd/system/

IDLE=/usr/local/sbin/progon-idle
if [ -f "$IDLE" ] && ! grep -q '/run/bds-sat-' "$IDLE"; then
  sudo cp -p "$IDLE" "$IDLE.pre-bds-sat"
  sudo sed -i 's#^  pgrep -f#  for f in /run/bds-sat-*/run.lock; do [ -e "$f" ] \&\& ! flock -n "$f" true \&\& return 0; done\n  pgrep -f#' "$IDLE"
fi
# unattended-upgrades при загрузке обновляет библиотеки, needrestart перезапускает задетые сервисы — и прогон
# посреди работы. После перезапуска не в свой день он выходит с «пропуск», прогон теряется.
NR=/etc/needrestart/conf.d/bds-sat.conf
if [ -d /etc/needrestart/conf.d ] && [ ! -f "$NR" ]; then
  # shellcheck disable=SC2016 # $nrconf — текст конфига Perl, не переменная
  printf '%s\n' '# bds-sat-*: needrestart не перезапускает прогоны спутников (bds-satellites RUNBOOK §11).' \
    '$nrconf{override_rc}{qr(^bds-sat-.*\.service$)} = 0;' | sudo install -m 644 /dev/stdin "$NR"
fi
sudo systemctl daemon-reload
sudo systemctl enable "$U.timer"
echo "дальше: /etc/$U.env → деплой (RUNBOOK §6) → sudo systemctl start $U.timer"
