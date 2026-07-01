#!/bin/bash
# -----------------------------------------------------------------------------
# sewing-cert-renew.sh — еженедельное авто-продление Let's Encrypt сертификатов
# для prod.teeon.ru и dev.teeon.ru.
#
# Как работает:
#   - Запускает `certbot renew --quiet` в docker. Сам certbot:
#       * проверяет каждый сертификат в /etc/letsencrypt/renewal/*.conf;
#       * если до истечения > 30 дней — НИЧЕГО не делает;
#       * если < 30 дней — выпускает новый и перезаписывает symlink в
#         /etc/letsencrypt/live/<domain>/.
#   - Для challenge используется webroot (`/var/www/certbot`), который
#     раздаёт nginx-сервис из docker-compose.prod.yml (см.
#     nginx/conf.d/00-shared.conf, location ^~ /.well-known/acme-challenge/).
#   - После успешного renewal через `--deploy-hook` перезапускает nginx,
#     чтобы он подхватил новые .pem без даунтайма (`nginx -s reload`).
#
# Требования:
#   - docker установлен и доступен;
#   - nginx-контейнер sewing-prod-nginx-1 поднят и слушает :80;
#   - порт 80 НЕ должен занимать другой процесс (в ACME-flow nginx сам
#     отдаёт challenge-токены, останавливать его не нужно).
#
# Лог:
#   - /var/log/sewing-cert-renew.log
#   - ротация — /etc/logrotate.d/sewing-letsencrypt
#
# Cron — /etc/cron.d/sewing-letsencrypt.
# -----------------------------------------------------------------------------
set -euo pipefail

NGINX_CONTAINER="${NGINX_CONTAINER:-sewing-prod-nginx-1}"

LOG=/var/log/sewing-cert-renew.log
mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1

echo "==== $(date -Iseconds) renew attempt ===="

# Самопроверка: nginx-контейнер должен быть поднят, иначе webroot пуст,
# challenge упадёт с 404 и LE откажет.
if ! docker inspect -f '{{.State.Running}}' "$NGINX_CONTAINER" 2>/dev/null | grep -qx true; then
  echo "ERROR: container '$NGINX_CONTAINER' is not running — webroot challenge не пройдёт."
  echo "       Поднимите prod-стек:"
  echo "         docker compose --env-file .env.prod -f docker-compose.base.yml -f docker-compose.prod.yml up -d nginx"
  exit 1
fi

# Доп. диагностика: убедимся, что :80 доступен снаружи (acme-сервер придёт
# на наш публичный IP через :80 → docker NAT → nginx).
if ! ss -tln '( sport = :80 )' 2>/dev/null | grep -q ':80'; then
  echo "WARN: port 80 не открыт на хосте; ACME challenge не доедет до nginx."
fi

# deploy-hook будет запущен ВНУТРИ certbot-контейнера, поэтому пробрасываем
# docker.sock (read-only монтирование не сработает — нужен RW для exec).
# Альтернатива — запускать certbot как обычно, а reload делать здесь же
# по rc=0. Берём вариант «свой reload» — проще и не требует socket в LE-контейнере.
set +e
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  -v /var/www/certbot:/var/www/certbot \
  certbot/certbot renew --quiet --no-random-sleep-on-renew
RC=$?
set -e

if [ $RC -eq 0 ]; then
  echo "OK: certbot renew rc=0"
  # Перезагрузим nginx ВСЕГДА после успешного renew. nginx -s reload — это
  # graceful: старые соединения дорабатывают на старом конфиге, новые
  # уходят на новый. Если certbot ничего не обновил — reload ничего не
  # сломает, просто перечитает те же файлы (стоимость ~миллисекунды).
  if docker exec "$NGINX_CONTAINER" nginx -t -q 2>>"$LOG"; then
    docker exec "$NGINX_CONTAINER" nginx -s reload && echo "OK: nginx reloaded"
  else
    echo "ERROR: nginx -t завалился, reload пропущен. Проверьте конфиг!"
    exit 2
  fi
  echo "==== OK renew completed ===="
else
  echo "==== FAIL renew rc=$RC ===="
  exit $RC
fi
