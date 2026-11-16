#!/usr/bin/env bash
# Такт сайта на progon (ADR 0002 §3). ExecStart юнита bds-sat-<site>.service (окружение — /etc/bds-sat-<site>.env).
#   - таймер срабатывает несколько раз в сутки; `sat tick` делает у каждой темы не больше одного шага,
#     новые темы выбирает первым тактом недели сайта (с 00:00 МСК schedule.day), расход — в потолке недели;
#   - SAT_FORCE=1 — полный прогон всех шагов (`sat run`), вручную через юнит;
#   - пауза: файл $SAT_STATE_DIR/PAUSE;
#   - память: чужие контейнеры с лимитами больше 6 ГБ — ждём час, до 3 раз, затем пропуск с записью в журнал;
#   - lock $RUNTIME_DIRECTORY/run.lock: сторож простоя progon считает сервер занятым, пока lock держит живой процесс.
# Ненулевой код — только когда упал сам прогон (тревогу шлёт сторож auto08 sat_last, RUNBOOK §7); ошибки статей — в журнале хаба.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
sat() { node --no-warnings=ExperimentalWarning "$PKG/dist/cli.js" "$@"; }

if [ -e "$SAT_STATE_DIR/PAUSE" ]; then
  echo "PAUSE — пропуск"
  exit 0
fi

# Вне юнита lock попал бы в /tmp, сторож простоя его не видит и выключает progon посреди прогона.
if [ -z "${RUNTIME_DIRECTORY:-}" ]; then
  echo "запуск только через юнит: RUNBOOK сайта §9 (systemctl set-environment SAT_FORCE=1)" >&2
  exit 2
fi
exec 9>"$RUNTIME_DIRECTORY/run.lock"
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

# SAT_COMMAND — команда автора над черновиками через тот же юнит и lock: «rework 636», «rerender 11 15».
# Без кавычек намеренно: команда и id разделяются пробелами.
default=tick
[ "${SAT_FORCE:-0}" = 1 ] && default=run
# shellcheck disable=SC2086
sat ${SAT_COMMAND:-$default}
