#!/usr/bin/env bash
# Первая установка сайта на progon (RUNBOOK §10). Запуск на progon от ubuntu (sudo), из любого места:
#   scp ops/install-site.sh deploy/* progon:/tmp/bds-sat-__SITE__/ (с wsa100), затем на progon: bash /tmp/bds-sat-__SITE__/install-site.sh
# Идемпотентно: пользователь в группе docker, read-only deploy keys (репо сайта и, если он приватный,
# bds-satellites — handbook gotchas/hosting.md#ro-deploy-key), клон в /opt, /var/lib, /etc env из
# .env.example, юниты, правка сторожа простоя (lock прогона спутника — занятость).
set -euo pipefail
SITE=__SITE__
U="bds-sat-$SITE"
HOME_U="/var/lib/$U"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Юниты и env.example — в ../deploy клона или рядом со скриптом (копия в /tmp при первой установке).
DEP="$HERE/../deploy"; [ -d "$DEP" ] || DEP="$HERE"

id "$U" >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir "$HOME_U" --shell /bin/bash "$U"
sudo usermod -aG docker "$U"
sudo install -d -o "$U" -g "$U" -m 750 "$HOME_U" "$HOME_U/runs"
sudo install -d -o "$U" -g "$U" -m 700 "$HOME_U/.ssh"

# Ключ на репо: GitHub не даёт добавить один deploy key в два репо.
key() { # имя-алиаса репо
  local alias=$1 repo=$2 file="$HOME_U/.ssh/$1"
  sudo -u "$U" test -e "$file" || sudo -u "$U" ssh-keygen -q -t ed25519 -N '' -C "progon $U $repo" -f "$file"
  if ! sudo -u "$U" grep -q "Host $alias" "$HOME_U/.ssh/config" 2>/dev/null; then
    printf 'Host %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$alias" "$file" \
      | sudo -u "$U" tee -a "$HOME_U/.ssh/config" >/dev/null
  fi
  echo "deploy key $repo (read-only): $(sudo cat "$file.pub")"
}
key github-$U "techfriends-eng/$U"
key github-bds-satellites techfriends-eng/bds-satellites
# Если bds-satellites приватный, npm берёт его по ssh через ключ этого алиаса.
for from in "ssh://git@github.com/techfriends-eng/bds-satellites" "https://github.com/techfriends-eng/bds-satellites" \
            "git@github.com:techfriends-eng/bds-satellites"; do
  sudo -u "$U" git config --global "url.git@github-bds-satellites:techfriends-eng/bds-satellites.insteadOf" "$from" || true
done
sudo -u "$U" ssh-keyscan -q github.com 2>/dev/null | sudo -u "$U" tee "$HOME_U/.ssh/known_hosts" >/dev/null

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
sudo systemctl daemon-reload
sudo systemctl enable "$U.timer"
echo "дальше: /etc/$U.env → деплой (RUNBOOK §6) → sudo systemctl start $U.timer"
