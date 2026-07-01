#!/bin/bash
# -----------------------------------------------------------------------------
# sewing-enable-demo2-dev.sh — turnkey-активация https://demo2.dev.teeon.ru.
#
# ЕДИНСТВЕННЫЙ внешний блокер: в публичном DNS Яндекса нет записи для
# demo2.dev.teeon.ru (namespace *.dev.teeon.ru не имеет wildcard). Как только
# владелец зоны добавит A-запись (wildcard *.dev.teeon.ru ИЛИ точечно
# demo2.dev.teeon.ru → IP сервера), этот скрипт сам:
#   1) увидит, что домен резолвится публично;
#   2) выпустит доверенный cert Let's Encrypt (HTTP-01 через webroot :80);
#   3) активирует nginx-vhost (25-demo2-dev-teeon.conf.disabled -> .conf);
#   4) проверит конфиг и сделает graceful reload (с откатом при ошибке).
#
# Идемпотентен: если всё уже сделано — тихо выходит 0. Если DNS ещё нет —
# логирует инструкцию и выходит 0 (безопасно гонять по cron хоть каждый день).
# Продление потом — общий sewing-cert-renew.sh (certbot renew подхватит).
#
# Лог: /var/log/sewing-enable-demo2-dev.log
# -----------------------------------------------------------------------------
set -euo pipefail

DOMAIN=demo2.dev.teeon.ru
SERVER_IP=159.194.208.32
CONF_DIR=/root/sewing/nginx/conf.d
VHOST_DISABLED="$CONF_DIR/25-demo2-dev-teeon.conf.disabled"
VHOST_ENABLED="$CONF_DIR/25-demo2-dev-teeon.conf"
NGINX_CONTAINER="${NGINX_CONTAINER:-sewing-prod-nginx-1}"
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

LOG=/var/log/sewing-enable-demo2-dev.log
mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1
echo "==== $(date -Iseconds) enable-demo2-dev ===="

# 1) Уже готово?
if [ -e "$CERT" ] && [ -e "$VHOST_ENABLED" ]; then
  echo "DONE: cert и vhost уже на месте, делать нечего."
  exit 0
fi

# 2) Домен резолвится в ПУБЛИЧНОМ DNS? (LE валидирует из интернета)
resolved="$(dig +short A "$DOMAIN" @dns1.yandex.net 2>/dev/null | tail -1)"
[ -z "$resolved" ] && resolved="$(dig +short A "$DOMAIN" @8.8.8.8 2>/dev/null | tail -1)"
if [ -z "$resolved" ]; then
  echo "WAIT: $DOMAIN ещё не в публичном DNS (NXDOMAIN)."
  echo "      Добавьте в DNS-панели Яндекса (зона teeon.ru) ОДНУ запись:"
  echo "        *.dev   A   $SERVER_IP     # wildcard, покроет все dev-тенанты (рекомендуется)"
  echo "      либо точечно:"
  echo "        demo2.dev   A   $SERVER_IP"
  echo "      Дальше скрипт (по cron или вручную) сам всё доделает."
  exit 0
fi
echo "DNS ok: $DOMAIN -> $resolved"

# 3) Нет cert — выпускаем HTTP-01 (webroot раздаёт nginx :80 через 00-shared).
if [ ! -e "$CERT" ]; then
  echo "Выпускаю cert для $DOMAIN (HTTP-01 webroot)..."
  set +e
  docker run --rm \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v /var/lib/letsencrypt:/var/lib/letsencrypt \
    -v /var/www/certbot:/var/www/certbot \
    certbot/certbot certonly --webroot -w /var/www/certbot \
      -d "$DOMAIN" --cert-name "$DOMAIN" --key-type ecdsa \
      --agree-tos --no-eff-email --non-interactive
  rc=$?
  set -e
  if [ $rc -ne 0 ] || [ ! -e "$CERT" ]; then
    echo "ERROR: certbot rc=$rc, cert не выпущен. vhost оставлен выключенным."
    exit 1
  fi
  echo "OK: cert выпущен."
fi

# 4) Активируем vhost (копируем шаблон .disabled -> .conf).
if [ ! -e "$VHOST_ENABLED" ]; then
  [ -e "$VHOST_DISABLED" ] || { echo "ERROR: нет шаблона $VHOST_DISABLED"; exit 1; }
  cp "$VHOST_DISABLED" "$VHOST_ENABLED"
  echo "vhost скопирован: $VHOST_ENABLED"
fi

# 5) Проверяем конфиг и делаем graceful reload; при ошибке — откат.
if docker exec "$NGINX_CONTAINER" nginx -t -q; then
  docker exec "$NGINX_CONTAINER" nginx -s reload && echo "OK: nginx reloaded — https://$DOMAIN активен."
else
  echo "ERROR: nginx -t упал после активации vhost — откатываю."
  rm -f "$VHOST_ENABLED"
  docker exec "$NGINX_CONTAINER" nginx -s reload || true
  exit 2
fi
echo "==== DONE ===="
