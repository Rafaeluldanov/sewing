#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# backup-db.sh — pre-deploy / периодический backup PostgreSQL для SEWING.
#
# Зачем не `pg_dump "$DATABASE_URL"`:
#   В .env строка вида
#       DATABASE_URL="postgresql://...:5432/sewing?schema=public"
#   Параметр `?schema=public` — это Prisma-расширение, libpq его не знает
#   и падает с "invalid URI query parameter: schema". На stage это уже
#   ловили. Поэтому DATABASE_URL парсим в Node (URL API) и передаём
#   pg_dump через стандартные PG* env vars.
#
# Можно явно подсунуть PG* через окружение — тогда .env не читается.
#
# Формат: pg_dump -Fc (custom, бинарный) — компактнее plain SQL и
# восстанавливается через pg_restore с --clean/--if-exists.
#
# Ротация: храним 14 последних файлов, всё что старше — удаляем.
#
# Запуск:
#   sudo bash /sewing/scripts/backup-db.sh
# или из deploy-stage.sh.
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sewing}"
KEEP="${KEEP:-14}"

# 1. Получаем PG* connection params.
#    Если уже выставлены извне (deploy-stage.sh может это сделать),
#    парсинг .env пропускаем — это даёт корректную работу из CI / cron,
#    где .env может не существовать.
if [[ -z "${PGDATABASE:-}" || -z "${PGUSER:-}" || -z "${PGHOST:-}" ]]; then
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "[backup-db] не найден ${ENV_FILE} и PG* не выставлены" >&2
    exit 1
  fi

  # node парсит URL без участия shell — кавычки/спецсимволы безопасны.
  # readFileSync + regex (а не require('dotenv')), чтобы не зависеть от
  # node_modules: backup может работать ещё до npm install.
  eval "$(
    ENV_FILE="${ENV_FILE}" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const p = process.env.ENV_FILE;
      const text = readFileSync(p, "utf8");
      const m = text.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
      if (!m) { console.error("DATABASE_URL не найден в " + p); process.exit(1); }
      let raw = m[1].trim();
      if ((raw.startsWith("\"") && raw.endsWith("\"")) ||
          (raw.startsWith("'\''") && raw.endsWith("'\''"))) {
        raw = raw.slice(1, -1);
      }
      const u = new URL(raw);
      const out = {
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
      };
      // Экранируем как single-quoted POSIX literal.
      const esc = (v) => "'\''" + String(v).replace(/'\''/g, "'\''\\'\'''\''") + "'\''";
      for (const [k, v] of Object.entries(out)) {
        console.log(`export ${k}=${esc(v)}`);
      }
    '
  )"
fi

: "${PGHOST:?PGHOST не определён}"
: "${PGPORT:?PGPORT не определён}"
: "${PGDATABASE:?PGDATABASE не определён}"
: "${PGUSER:?PGUSER не определён}"
# PGPASSWORD может быть пустым, если используется .pgpass / peer auth.
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

# 2. Готовим директорию.
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

ts="$(date +%Y%m%d_%H%M%S)"
out="${BACKUP_DIR}/sewing_${ts}.dump"
tmp="${out}.partial"

# 3. Дамп. -Fc — custom binary; --no-owner/--no-acl делает дамп
#    переносимым между БД с разными ролями (важно при restore из stage
#    в локальный dev и наоборот).
echo "[backup-db] pg_dump ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} → ${out}"
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="${tmp}" \
  "${PGDATABASE}"

# atomic rename: не хотим в ротации увидеть полу-записанный .partial.
mv "${tmp}" "${out}"

size="$(du -h "${out}" | awk '{print $1}')"
echo "[backup-db] OK ${out} (${size})"

# 4. Ротация: оставляем KEEP свежих файлов.
mapfile -t old < <(ls -1t "${BACKUP_DIR}"/sewing_*.dump 2>/dev/null | tail -n +"$((KEEP + 1))")
for f in "${old[@]}"; do
  echo "[backup-db] rotate: rm ${f}"
  rm -f -- "${f}"
done

# stdout: путь созданного файла (последняя строка) — чтобы deploy-stage.sh
# мог захватить его через `BACKUP_FILE=$(scripts/backup-db.sh | tail -1)`.
echo "${out}"
