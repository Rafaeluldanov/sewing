#!/usr/bin/env bash
# Утренний сброс выставочного тенанта `expo` (expo.teeon.ru) к чистому снапшоту.
#
# Снапшот сделан 14.09.2026 сразу после подготовки (справочники из seed.ts,
# экспо-учётки, ни одного заказа): /var/backups/sewing/expo/tenant_expo_clean_*.dump
# Восстановление стирает всё, что накопилось за день показов (заказы, паспорта,
# смены, начисления). Только tenant_expo — боевую БД myapp скрипт не тронет.
#
#   bash scripts/demo/expo-restore-db.sh                      # последний clean-снапшот
#   bash scripts/demo/expo-restore-db.sh /path/to/other.dump  # конкретный файл
#
# Новый снапшот после перенастройки стенда:
#   docker exec sewing-prod-db-1 pg_dump -U user --format=custom --no-owner --no-acl tenant_expo \
#     > /var/backups/sewing/expo/tenant_expo_clean_$(date +%Y%m%d).dump
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-sewing-prod-db-1}"
DB_USER="${DB_USER:-user}"
TENANT_DB="tenant_expo"
DUMP="${1:-$(ls -1t /var/backups/sewing/expo/tenant_expo_clean_*.dump 2>/dev/null | head -1)}"

if [ -z "${DUMP}" ] || [ ! -f "${DUMP}" ]; then
  echo "Снапшот не найден: ${DUMP:-/var/backups/sewing/expo/tenant_expo_clean_*.dump}" >&2
  exit 1
fi

echo "Восстанавливаю ${TENANT_DB} из ${DUMP} (контейнер ${DB_CONTAINER})…"
# --clean --if-exists: объекты пересоздаются; открытые сессии API отваливаются
# и переподключаются сами (Prisma пул), пользователей на стенде в этот момент
# быть не должно.
docker exec -i "${DB_CONTAINER}" pg_restore -U "${DB_USER}" -d "${TENANT_DB}" \
  --clean --if-exists --no-owner --no-acl --single-transaction < "${DUMP}"

echo "Готово."

# Машинный токен ERP (erp.upgifts.ru, тенант expo → sewing.connection) выпущен ПОСЛЕ чистого
# снапшота, в дампе его нет. Файл хранит только sha256 (плейнтекст лежит в ERP), INSERT
# идемпотентен (ON CONFLICT DO NOTHING). Без этого шага после сброса ERP получает 401.
POST_SQL="/var/backups/sewing/expo/post-restore.sql"
if [ -f "${POST_SQL}" ]; then
  docker exec -i "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${TENANT_DB}" -v ON_ERROR_STOP=1 -q < "${POST_SQL}"
  echo "Применил ${POST_SQL} (токен ERP)."
fi
# Самопроверка учёток и рабочих мест — нужен пароль админа expo-тенанта
# (в снапшоте он НЕ сидовый). Без него шаг пропускаем с подсказкой.
if [ -n "${SEWING_ADMIN_PASSWORD:-}" ]; then
  node "$(dirname "$0")/expo-setup.mjs" --host expo.teeon.ru --api https://expo.teeon.ru
else
  echo "Проверку пропустил: задайте SEWING_ADMIN_PASSWORD=<пароль admin@expo> и запустите"
  echo "  node scripts/demo/expo-setup.mjs --host expo.teeon.ru --api https://expo.teeon.ru"
fi
