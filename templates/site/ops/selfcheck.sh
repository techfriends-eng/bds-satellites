#!/usr/bin/env bash
# Готовность сайта на progon: общий selfcheck пакета с окружением сайта (RUNBOOK §9).
#   sudo -u bds-sat-__SITE__ -H /opt/bds-sat-__SITE__/ops/selfcheck.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck source=/dev/null  # секреты сайта на хосте
. /etc/bds-sat-__SITE__.env
set +a
exec node_modules/bds-satellites/ops/selfcheck.sh
