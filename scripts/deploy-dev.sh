#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# deploy-dev.sh — repeatable деплой DEV-окружения SEWING.
#
# Назначение: вызывается вручную или из CI/CD после merge в ветку `develop`.
# Идемпотентен — повторный запуск без изменений не ломает работающие
# контейнеры и не создаёт дубликатов данных.
#
# Compose-файлы (dev):
#   - docker-compose.base.yml   — общий postgres-сервис, network, volume
#   - docker-compose.dev.yml    — api + web (bind-mount исходников, hot reload)
# Project name:    sewing
# Env-file:        .env.dev
#
# Никаких секретов в этом скрипте нет — пароли БД, JWT_SECRET и т.п.
# должны лежать в .env.dev на сервере (вне репозитория и git history).
#
# Запуск:
#   sudo bash /root/sewing/scripts/deploy-dev.sh
#
# Параметры через env (можно переопределить из CI):
#   DEPLOY_BRANCH       — git-ветка дев-окружения (default: develop)
#   API_HEALTH_URL      — URL для healthcheck API (default из dev compose)
#   HEALTH_ATTEMPTS     — попыток healthcheck (default 30)
#   HEALTH_DELAY_S      — пауза между попытками, сек (default 2)
#   SKIP_MIGRATIONS=1   — пропустить шаг `prisma migrate deploy`
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/root/sewing}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-develop}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-sewing}"
ENV_FILE="${ENV_FILE:-.env.dev}"

# Compose-файлы для dev. Порядок важен: base первым, потом dev (override).
COMPOSE_FILES=(
  -f docker-compose.base.yml
  -f docker-compose.dev.yml
)

# Healthcheck:
#   - dev API listens on host :3001 (см. docker-compose.dev.yml).
#   - 401 UNAUTHENTICATED — корректный ответ /api/auth/me без cookie.
#   - 200 — если CI/devуже залогинен, тоже ок.
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3001/api/auth/me}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_DELAY_S="${HEALTH_DELAY_S:-2}"

log() { printf '\n[deploy-dev] %s\n' "$*"; }

# -----------------------------------------------------------------------------
# 0. Sanity / cwd
# -----------------------------------------------------------------------------
if [ ! -d "${REPO_ROOT}/.git" ]; then
  echo "[deploy-dev] FATAL: ${REPO_ROOT} is not a git checkout" >&2
  exit 1
fi
cd "${REPO_ROOT}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "[deploy-dev] FATAL: ${ENV_FILE} not found in ${REPO_ROOT}" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Git fetch + checkout + ff-only pull
# -----------------------------------------------------------------------------
log "git fetch origin"
git fetch --prune origin

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${CURRENT_BRANCH}" != "${DEPLOY_BRANCH}" ]; then
  log "switching branch: ${CURRENT_BRANCH} → ${DEPLOY_BRANCH}"
  git checkout "${DEPLOY_BRANCH}"
fi

log "git pull --ff-only origin ${DEPLOY_BRANCH}"
git pull --ff-only origin "${DEPLOY_BRANCH}"

GIT_COMMIT_SHORT="$(git rev-parse --short HEAD)"
GIT_COMMIT_SUBJECT="$(git log -1 --pretty=%s)"
log "deploying commit: ${GIT_COMMIT_SHORT}  ${GIT_COMMIT_SUBJECT}"

# -----------------------------------------------------------------------------
# 2. Docker compose build + up
# -----------------------------------------------------------------------------
DC_BASE=(docker compose -p "${COMPOSE_PROJECT}" "${COMPOSE_FILES[@]}" --env-file "${ENV_FILE}")

log "docker compose build"
"${DC_BASE[@]}" build

log "docker compose up -d --remove-orphans"
"${DC_BASE[@]}" up -d --remove-orphans

# -----------------------------------------------------------------------------
# 3. Prisma migrations (внутри контейнера api)
#
# `migrate deploy` — каноническая команда для прод/dev: применяет
# pending-миграции из `prisma/migrations`. Ничего не пушит руками.
# Если истории миграций ещё нет (свежий volume), автоматический
# entrypoint API уже выполнил `prisma db push` (PRISMA_AUTO_SYNC=1).
# Поэтому если migrate deploy упал — НЕ валим деплой, а просто пишем
# предупреждение и идём дальше (схема всё равно синхронизирована).
# -----------------------------------------------------------------------------
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  log "prisma migrate deploy (inside api container)"
  if ! "${DC_BASE[@]}" exec -T api npx prisma migrate deploy --schema=prisma/schema.prisma; then
    echo "[deploy-dev] WARN: prisma migrate deploy failed — schema may already be in sync" >&2
    echo "[deploy-dev] WARN: continuing (PRISMA_AUTO_SYNC entrypoint runs on container start)" >&2
  fi
else
  log "SKIP_MIGRATIONS=1 → пропускаем prisma migrate deploy"
fi

# -----------------------------------------------------------------------------
# 4. Status: containers + recent logs (best-effort)
# -----------------------------------------------------------------------------
log "docker compose ps"
"${DC_BASE[@]}" ps

log "recent api logs (last 30 lines, best-effort)"
"${DC_BASE[@]}" logs --tail=30 api 2>&1 || true

log "recent web logs (last 30 lines, best-effort)"
"${DC_BASE[@]}" logs --tail=30 web 2>&1 || true

# -----------------------------------------------------------------------------
# 5. Healthcheck
#
# Принимаем 200 (есть валидная сессия) ИЛИ 401 (анонимный запрос — ожидаемо).
# Любые 5xx, connection refused, timeout — ошибка деплоя.
# -----------------------------------------------------------------------------
log "healthcheck: ${API_HEALTH_URL} (accept 200 or 401)"
attempt=0
while :; do
  attempt=$((attempt + 1))
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${API_HEALTH_URL}" || echo '000')"
  case "${status}" in
    200|401)
      log "API healthy: HTTP ${status}"
      break
      ;;
    *)
      if [ "${attempt}" -ge "${HEALTH_ATTEMPTS}" ]; then
        echo "[deploy-dev] FATAL: API not healthy after ${attempt} attempts (last status: ${status})" >&2
        exit 1
      fi
      echo "  attempt ${attempt}/${HEALTH_ATTEMPTS} — got ${status}, retry in ${HEALTH_DELAY_S}s"
      sleep "${HEALTH_DELAY_S}"
      ;;
  esac
done

log "DEPLOY DEV OK — commit ${GIT_COMMIT_SHORT} on branch ${DEPLOY_BRANCH}"
