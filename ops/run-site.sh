#!/usr/bin/env bash
# Недельный прогон сайта на progon. ExecStart юнита bds-sat-<site>.service (окружение — /etc/bds-sat-<site>.env).
#   - только в день schedule.day конфига: progon поднимают и для статей блога, а Persistent=true
#     таймера догоняет пропуск при любом включении (SAT_FORCE=1 — прогон вне дня, вручную);
#   - пауза: файл $SAT_STATE_DIR/PAUSE;
#   - память: чужие контейнеры с лимитами больше 6 ГБ — ждём час, до 3 раз, затем пропуск с записью в журнал;
#   - lock $RUNTIME_DIRECTORY/run.lock: сторож простоя progon считает сервер занятым, пока lock держит живой процесс.
# Ненулевой код — только когда упал сам прогон (OnFailure → тревога в LOGS); ошибки статей — в журнале хаба.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
sat() { node --no-warnings=ExperimentalWarning "$PKG/dist/cli.js" "$@"; }

day=$(sed -n 's/^schedule:.*day: *\([a-z]*\).*/\1/p' "$SAT_SITE_DIR/config/site.yaml")
today=$(TZ=Europe/Moscow date +%a | tr '[:upper:]' '[:lower:]')
if [ "${SAT_FORCE:-0}" != 1 ] && [ "$today" != "${day:-mon}" ]; then
  echo "сегодня $today, день сайта ${day:-mon} — пропуск"
  exit 0
fi
if [ -e "$SAT_STATE_DIR/PAUSE" ]; then
  echo "PAUSE — пропуск"
  exit 0
fi

exec 9>"${RUNTIME_DIRECTORY:-/tmp}/run.lock"
flock -n 9 || { echo "прогон уже идёт"; exit 0; }

others_mb() {
  local total=0 id mem
  for id in $(docker ps -q); do
    mem=$(docker inspect -f '{{.HostConfig.Memory}}' "$id")
    total=$((total + mem / 1048576))
  done
  echo "$total"
}
for try in 1 2 3 4; do
  used=$(others_mb)
  [ "$used" -le 6144 ] && break
  if [ "$try" = 4 ]; then
    echo "память: чужие контейнеры ${used} МБ > 6144 — пропуск"
    sat note "пропуск: чужие контейнеры ${used} МБ"
    exit 0
  fi
  echo "память: чужие контейнеры ${used} МБ, жду час ($try/3)"
  sleep 3600
done

sat run
