#!/bin/bash
# -----------------------------------------------------------------------------
# sewing-cert-check.sh — ежедневная проверка срока действия ВСЕХ Let's Encrypt
# сертификатов проекта sewing.
#
# Что делает:
#   - АВТО-ОБНАРУЖЕНИЕ: берёт каждый /etc/letsencrypt/live/*/fullchain.pem
#     (раньше был захардкожен список prod.teeon.ru + dev.teeon.ru, из-за чего
#     demo2.teeon.ru и прочие тенант-серты не мониторились вовсе).
#   - Считает, сколько дней до notAfter.
#   - Логирует одну строку на сертификат:
#       OK:   <d> expires in N days (<date>)   — если N >= WARN_DAYS
#       WARN: <d> expires in N days (<date>)   — если N <  WARN_DAYS
#       EXPIRED: <d> expired N days ago (<date>) — если уже истёк
#
# Пороги:
#   - WARN_DAYS=30 — стандарт для LE: если меньше — значит auto-renew почему-то
#     не сработал, это сигнал разобраться.
#
# Где смотреть:
#   - /var/log/sewing-cert-check.log
#   - Быстро глянуть последний результат:
#       tail -n 20 /var/log/sewing-cert-check.log
#
# Exit code:
#   - 0 если все сертификаты ок (>= WARN_DAYS дней),
#   - 1 если хотя бы один WARN/EXPIRED. Полезно для wrapper-cron'а или
#     внешнего monitoring (alertmanager / healthcheck.io / e-mail-on-fail).
# -----------------------------------------------------------------------------
set -euo pipefail

WARN_DAYS=${WARN_DAYS:-30}
LIVE_DIR=/etc/letsencrypt/live

LOG=/var/log/sewing-cert-check.log
mkdir -p "$(dirname "$LOG")"

stamp="$(date -Iseconds)"
overall_rc=0
{
  echo "==== $stamp check (warn_days=$WARN_DAYS) ===="

  shopt -s nullglob
  found=0
  for cert in "$LIVE_DIR"/*/fullchain.pem; do
    found=1
    d="$(basename "$(dirname "$cert")")"
    # `openssl x509 -enddate` отдаёт строку вида:
    #   notAfter=Aug  2 13:56:28 2026 GMT
    expiry=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2-)
    expiry_ts=$(date -d "$expiry" +%s)
    now_ts=$(date +%s)
    days_left=$(( (expiry_ts - now_ts) / 86400 ))

    if [ "$days_left" -lt 0 ]; then
      echo "EXPIRED: $d expired $((-days_left)) days ago ($expiry)"
      overall_rc=1
    elif [ "$days_left" -lt "$WARN_DAYS" ]; then
      echo "WARN: $d expires in $days_left days ($expiry)"
      overall_rc=1
    else
      echo "OK:   $d expires in $days_left days ($expiry)"
    fi
  done

  if [ "$found" -eq 0 ]; then
    echo "MISSING: no certificates under $LIVE_DIR/*/fullchain.pem"
    overall_rc=1
  fi
} | tee -a "$LOG"

exit $overall_rc
