#!/usr/bin/env bash
# ADR 0005: таблица предложений BDS `sat.bds_offers` и доступ Stack Radar к ней (трек «Лонгрид BDS»).
# Запуск автором с wsa100 в обычном терминале (sudo и секреты на auto08 у Claude закрыты):
#   bash ~/work/bds-satellites/ops/bds_offers_setup.sh
# Что делает на auto08, идемпотентно:
#   1. база sat: таблица sat.bds_offers; sat_writer (спутники) — SELECT/INSERT/UPDATE, sat_hub — SELECT;
#   2. роль sat_radar (пароль генерируется на auto08 и живёт только в /etc/stack-radar.env):
#      SELECT и UPDATE (status, decided_at, card_msg_id, card_sent_at), вход только с 127.0.0.1;
#   3. /etc/stack-radar.env: SAT_OFFERS_DB_URL и PICK_LONGREAD_THREAD_ID=1942 (тема «longreadBDS»);
#   4. рестарт stack-radar и проба: роль читает sat.bds_offers.
# Откат: убрать обе переменные из env и строку sat_radar из pg_hba, `systemctl reload postgresql`,
# `systemctl restart stack-radar`; `sudo -u postgres psql -d sat -c 'DROP TABLE sat.bds_offers; DROP ROLE sat_radar'`.
# Спутники без таблицы пишут ошибку в stats.bds_offers_error и не добирают темы — откатывать вместе с
# тегом пакета ниже 0.1.56 в сайтах.
set -euo pipefail
THREAD_ID="${1:-1942}"

# shellcheck disable=SC2029  # THREAD_ID подставляется здесь
ssh auto08 "THREAD_ID='$THREAD_ID' bash -s" <<'REMOTE'
set -euo pipefail
HBA=/etc/postgresql/16/main/pg_hba.conf
ENV=/etc/stack-radar.env

echo "== sat.bds_offers"
sudo -u postgres psql -d sat -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS sat.bds_offers (
  id              bigserial PRIMARY KEY,
  url_hash        text NOT NULL UNIQUE,          -- sha1 ключа dedupUrl спутника: один материал — одно предложение
  url             text NOT NULL,
  site            text NOT NULL,                 -- спутник, предложивший первым
  candidate_id    bigint NOT NULL,
  title           text NOT NULL,
  summary         text,
  source_id       text,
  source_kind     text,                          -- blog | release | aggregator | youtube
  score_relevance int,
  score_depth     int,
  reason          text,
  offered_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_at      timestamptz,
  card_msg_id     bigint,                        -- карточка Stack Radar в теме longreadBDS
  card_sent_at    timestamptz
);
CREATE INDEX IF NOT EXISTS bds_offers_status ON sat.bds_offers (status);
GRANT SELECT, INSERT, UPDATE ON sat.bds_offers TO sat_writer;
GRANT USAGE ON SEQUENCE sat.bds_offers_id_seq TO sat_writer;
GRANT SELECT ON sat.bds_offers TO sat_hub;
SQL

PW=""
if ! sudo grep -q '^SAT_OFFERS_DB_URL=' "$ENV"; then
  PW=$(openssl rand -hex 24)
fi
echo "== роль sat_radar"
sudo -u postgres psql -d sat -v ON_ERROR_STOP=1 -q -v pw="$PW" <<'SQL'
SELECT format('CREATE ROLE sat_radar LOGIN CONNECTION LIMIT 3')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sat_radar') \gexec
SELECT format('ALTER ROLE sat_radar PASSWORD %L', :'pw') WHERE :'pw' <> '' \gexec
ALTER ROLE sat_radar SET statement_timeout = '30s';
GRANT CONNECT ON DATABASE sat TO sat_radar;
GRANT USAGE ON SCHEMA sat TO sat_radar;
GRANT SELECT ON sat.bds_offers TO sat_radar;
GRANT UPDATE (status, decided_at, card_msg_id, card_sent_at) ON sat.bds_offers TO sat_radar;
SQL

if ! sudo grep -qE '^host\s+sat\s+sat_radar\s+127\.0\.0\.1/32' "$HBA"; then
  echo "== pg_hba: sat_radar с localhost"
  sudo cp -p "$HBA" "$HBA.bak-$(date +%F)"
  printf '\n# Stack Radar, трек «Лонгрид BDS» (ADR 0005 bds-satellites, 2026-11-23)\nhost    sat             sat_radar       127.0.0.1/32            scram-sha-256\n' \
    | sudo tee -a "$HBA" >/dev/null
  sudo systemctl reload postgresql; sleep 2
fi

if [ -n "$PW" ]; then
  echo "== $ENV: SAT_OFFERS_DB_URL"
  printf 'SAT_OFFERS_DB_URL=postgresql://sat_radar:%s@127.0.0.1:5432/sat\n' "$PW" | sudo tee -a "$ENV" >/dev/null
fi
if ! sudo grep -q '^PICK_LONGREAD_THREAD_ID=' "$ENV"; then
  echo "== $ENV: PICK_LONGREAD_THREAD_ID=$THREAD_ID"
  printf 'PICK_LONGREAD_THREAD_ID=%s\n' "$THREAD_ID" | sudo tee -a "$ENV" >/dev/null
fi

URL=$(sudo sed -n 's/^SAT_OFFERS_DB_URL=//p' "$ENV" | tail -1)
echo "проба sat_radar: $(sudo -u stackradar psql "$URL" -Atqc 'select count(*) from sat.bds_offers' 2>&1) строк"
sudo systemctl restart stack-radar.service; sleep 5
echo "stack-radar: $(systemctl is-active stack-radar), http: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/)"
echo "ошибок в pg_hba: $(sudo -u postgres psql -Atc 'select count(*) from pg_hba_file_rules where error is not null')"
REMOTE
