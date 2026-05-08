#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# backup-db.sh — pre-deploy / периодический backup PostgreSQL для SEWING.
#
# Делает `pg_dump` ВНУТРИ контейнера postgres через `docker exec`. Это
# избавляет от необходимости иметь `pg_dump` той же major-версии на
# хосте (раньше скрипт падал «pg_dump: command not found» в средах,
# где postgresql-client не установлен) и не зависит от
# `.env::DATABASE_URL` — креды берём из env-vars самого контейнера
# (`POSTGRES_USER` / `POSTGRES_DB`), а пароль не нужен, потому что
# обращение идёт через unix-socket внутри контейнера.
#
# Формат: `pg_dump --format=custom --no-owner --no-acl` — компактный
# binary, восстанавливается через `pg_restore --clean --if-exists`,
# переносится между БД с разными ролями (важно при restore stage→dev
# и наоборот).
#
# Ротация: оставляем `KEEP` последних файлов с тем же `FILE_PREFIX`,
# всё что старше — удаляем.
#
# Параметры (env, можно переопределить из CI):
#   CONTAINER     — имя контейнера postgres (default: sewing-prod-db-1).
#                   Для dev: CONTAINER=sewing-db-1
#   BACKUP_DIR    — каталог для дампов (default: /var/backups/sewing).
#   KEEP          — сколько последних файлов хранить (default: 14).
#   FILE_PREFIX   — префикс имени файла (default: sewing). Полезно
#                   развести prod- и dev-бэкапы в одном каталоге:
#                   FILE_PREFIX=sewing_prod / FILE_PREFIX=sewing_dev.
#
# stdout: путь созданного файла (последняя строка) — чтобы вызывающий
# скрипт мог захватить его через `BACKUP_FILE=$(scripts/backup-db.sh | tail -1)`.
#
# Запуск:
#   sudo bash /root/sewing/scripts/backup-db.sh
#   sudo CONTAINER=sewing-db-1 FILE_PREFIX=sewing_dev \
#        bash /root/sewing/scripts/backup-db.sh
# -----------------------------------------------------------------------------

set -euo pipefail

CONTAINER="${CONTAINER:-sewing-prod-db-1}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sewing}"
KEEP="${KEEP:-14}"
FILE_PREFIX="${FILE_PREFIX:-sewing}"

# 1. Sanity: контейнер существует и запущен. Без `Running: true`
#    `docker exec` упадёт с невнятным сообщением — лучше ловим раньше.
if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "[backup-db] контейнер ${CONTAINER} не найден" >&2
  exit 1
fi
running="$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || echo false)"
if [[ "${running}" != "true" ]]; then
  echo "[backup-db] контейнер ${CONTAINER} не запущен (State.Running=${running})" >&2
  exit 1
fi

# 2. Креды из env-vars контейнера. Postgres-образ официально
#    выставляет `POSTGRES_USER` / `POSTGRES_DB` — отсюда и берём.
PGUSER="$(docker exec "${CONTAINER}" sh -c 'printf "%s" "${POSTGRES_USER:-}"')"
PGDATABASE="$(docker exec "${CONTAINER}" sh -c 'printf "%s" "${POSTGRES_DB:-}"')"
if [[ -z "${PGUSER}" || -z "${PGDATABASE}" ]]; then
  echo "[backup-db] POSTGRES_USER/POSTGRES_DB не выставлены в ${CONTAINER}" >&2
  exit 1
fi

# 3. Готовим директорию (с правильными правами — содержит pg_dump'ы
#    с PII, оставлять чтение для всех нельзя).
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

ts="$(date +%Y%m%d_%H%M%S)"
out="${BACKUP_DIR}/${FILE_PREFIX}_${ts}.dump"
tmp="${out}.partial"

# 4. Дамп. Внутри контейнера используем -h /var/run/postgresql (unix
#    socket дефолтного образа postgres:15+); пароль не нужен (peer/trust).
#    Чтобы скрипт не зависел от расположения сокета у разных образов,
#    проще явно не указывать `-h` — libpq возьмёт сокет по дефолту.
echo "[backup-db] pg_dump ${PGUSER}@${CONTAINER}/${PGDATABASE} → ${out}"
docker exec "${CONTAINER}" pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  > "${tmp}"

# atomic rename — в ротации не должны видеть `.partial`.
mv "${tmp}" "${out}"

size="$(du -h "${out}" | awk '{print $1}')"
echo "[backup-db] OK ${out} (${size})"

# 5. Ротация: оставляем KEEP свежих файлов c тем же FILE_PREFIX.
#    Чужие префиксы (например, sewing_dev_*.dump при FILE_PREFIX=sewing_prod)
#    скрипт НЕ трогает.
mapfile -t old < <(ls -1t "${BACKUP_DIR}/${FILE_PREFIX}_"*.dump 2>/dev/null | tail -n +"$((KEEP + 1))")
for f in "${old[@]}"; do
  echo "[backup-db] rotate: rm ${f}"
  rm -f -- "${f}"
done

# stdout: путь созданного файла последней строкой.
echo "${out}"
