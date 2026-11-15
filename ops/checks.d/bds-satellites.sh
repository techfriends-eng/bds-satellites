# shellcheck shell=bash
# Доменные сторожа сайтов-спутников для общего /opt/monitoring/check.sh (toolkit ops/monitoring) на auto08.
# Подключается через source; доступны note и grade. Данные — база sat (журнал, пишет progon).
# Установка на auto08:
#   sudo install -m 640 -g monitoring ops/checks.d/bds-satellites.sh /opt/monitoring/checks.d/
# Тишина — сбой (handbook standards/08 M8): progon включается по расписанию, и пропущенный прогон
# изнутри не виден — его видит только этот сторож снаружи.

psql_sat() { sudo -u postgres psql -qtAX -d sat "$@"; }

if ! psql_sat -c 'select 1' >/dev/null 2>&1; then
  note sat_db crit "база sat недоступна" "sudo -u postgres psql -d sat -c '\\dt sat.*'"
  return 0
fi

# Возраст последнего прогона без ошибки по каждому сайту. Прогон недельный, в 02:00 МСК, юнит
# живёт до 8 ч: следующий успешный прогон ждём не позже 168 + 12 ч. warn — пропущен один прогон
# (180 ч), crit — два (348 ч). Строка в sat.runs пишется только в конце прогона, поэтому упавший
# целиком прогон виден здесь только тишиной.
while IFS='|' read -r site age_h; do
  [ -n "$site" ] || continue
  note "sat_run:$site" "$(grade "$age_h" 180 348)" "${age_h} ч назад" \
    "ssh progon 'journalctl -u bds-sat-$site.service -n 50 --no-pager'"
done < <(psql_sat -F'|' -c "
  select site, round(extract(epoch from now() - max(finished_at)) / 3600)::int
    from sat.runs where error is null group by site order by site")

# Последний прогон сайта закончился ошибкой: сообщаем сразу, не дожидаясь недели тишины.
# Это замена OnFailure на progon: тревоги шлёт auto08, у progon нет ни токена, ни постоянной работы.
while IFS='|' read -r site at err; do
  [ -n "$site" ] || continue
  if [ -n "$err" ]; then
    note "sat_last:$site" warn "последний прогон $at с ошибкой: ${err:0:120}" \
      "ssh progon 'journalctl -u bds-sat-$site.service -n 80 --no-pager'"
  else
    note "sat_last:$site" ok "последний прогон $at без ошибки"
  fi
done < <(psql_sat -F'|' -c "
  select distinct on (site) site,
         to_char(finished_at at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI'),
         coalesce(replace(replace(error, '|', '/'), E'\n', ' '), '')
    from sat.runs order by site, finished_at desc")

# Статьи, которые проверки отклонили два прогона подряд и дольше 14 суток лежат черновиками:
# конвейер работает, а на сайт ничего не выходит.
stuck=$(psql_sat -c "select count(*) from sat.articles
  where status in ('gate_failed', 'run_failed') and updated_at < now() - interval '14 days'")
note sat_stuck "$(grade "${stuck:-0}" 3 8)" "${stuck:-0} черновиков без прохода проверок > 14 сут" \
  "BDS Хаб, раздел «Спутники»"
