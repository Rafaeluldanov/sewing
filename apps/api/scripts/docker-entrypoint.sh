#!/bin/sh
# API container entrypoint.
#
# Назначение: перед запуском Node-процесса опционально синхронизировать
# схему БД с `prisma/schema.prisma`. Закрывает кейс, когда после
# `docker compose up -d --build` Prisma-client из нового образа знает
# колонки, которых ещё нет в существующем postgres-volume, и API падает
# с `The column ... does not exist in the current database`.
#
# Управляется одной переменной окружения:
#   PRISMA_AUTO_SYNC   1/true/on/yes — синхронизировать схему;
#                      0/false/off/no/<пусто> — пропустить (default в dev).
#
# Доп. флаги:
#   PRISMA_AUTO_SYNC_RETRIES         сколько раз пытаться (default 15);
#                                    нужно, потому что postgres может ещё
#                                    подниматься в момент старта api.
#   PRISMA_AUTO_SYNC_ACCEPT_DATA_LOSS  1 → добавить `--accept-data-loss`
#                                    (требуется, если push выполняет
#                                    деструктивную операцию). Default off.
#   PRISMA_AUTO_SYNC_DISABLED_HINT     если sync выключен, выводит
#                                    подсказку «как включить» (только в
#                                    dev/CI, чтобы случайно не забыли).
#
# Скрипт всегда заканчивает `exec "$@"`, чтобы CMD из Dockerfile
# (или из compose) выполнился штатно и сохранил PID 1 для сигналов.

set -e

is_truthy() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On|enabled|ENABLED) return 0 ;;
    *) return 1 ;;
  esac
}

run_prisma_sync() {
  echo "[entrypoint] PRISMA_AUTO_SYNC=${PRISMA_AUTO_SYNC} → sync prisma schema"
  cd /app
  flags="--schema=prisma/schema.prisma --skip-generate"
  if is_truthy "${PRISMA_AUTO_SYNC_ACCEPT_DATA_LOSS:-}"; then
    echo "[entrypoint] PRISMA_AUTO_SYNC_ACCEPT_DATA_LOSS=on → adding --accept-data-loss"
    flags="$flags --accept-data-loss"
  fi
  attempts=0
  max_attempts="${PRISMA_AUTO_SYNC_RETRIES:-15}"
  # shellcheck disable=SC2086
  until npx --no-install prisma db push $flags; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
      echo "[entrypoint] prisma db push failed after ${attempts} attempts; aborting" >&2
      exit 1
    fi
    echo "[entrypoint] prisma db push failed (${attempts}/${max_attempts}); retry in 2s" >&2
    sleep 2
  done
  echo "[entrypoint] prisma schema is in sync"
}

if is_truthy "${PRISMA_AUTO_SYNC:-}"; then
  run_prisma_sync
else
  if [ -n "${PRISMA_AUTO_SYNC:-}" ]; then
    echo "[entrypoint] PRISMA_AUTO_SYNC=${PRISMA_AUTO_SYNC} → skip prisma sync"
  fi
fi

exec "$@"
