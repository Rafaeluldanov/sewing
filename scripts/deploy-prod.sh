#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# deploy-prod.sh — repeatable деплой PROD-окружения SEWING.
#
# Назначение: вызывается вручную или из CI/CD после merge в ветку `main`.
# Идемпотентен — повторный запуск без изменений не ломает работающие
# контейнеры, не создаёт дубликатов БД и не теряет existing данные.
#
# Compose-файлы (prod):
#   - docker-compose.base.yml   — общий postgres-сервис, network, volume
#   - docker-compose.prod.yml   — api + web (build из образа, без bind-mount),
#                                 prod-сеть `prod-network`, том `prod_db_data`
# Project name:    sewing-prod   (ИЗОЛИРОВАН от dev `sewing` — отдельные
#                                 контейнеры, тома, сеть)
# Env-file:        .env.prod
#
# В .env.prod лежат:
#   DB_PASSWORD            — пароль postgres (НЕ коммитить)
#   NEXT_PUBLIC_API_URL    — публичный URL API для client bundle (build-time)
#   PRISMA_AUTO_SYNC       — 0/1, см. apps/api/scripts/docker-entrypoint.sh.
#                            На prod = 0: схему ведёт ТОЛЬКО migrate deploy,
#                            db push на старте контейнера отключён.
#
# Никаких секретов в этом скрипте нет.
#
# Запуск:
#   sudo bash /root/sewing/scripts/deploy-prod.sh
#
# Параметры через env (можно переопределить из CI):
#   DEPLOY_BRANCH       — git-ветка прод-окружения (default: main)
#   API_HEALTH_URL      — URL для healthcheck API (default из prod compose)
#   HEALTH_ATTEMPTS     — попыток healthcheck (default 30)
#   HEALTH_DELAY_S      — пауза между попытками, сек (default 2)
#   SKIP_MIGRATIONS=1   — пропустить шаг `prisma migrate deploy`
#   SKIP_BACKUP=1       — пропустить авто-бэкап БД перед миграциями
#   BACKUP_KEEP         — сколько последних predeploy-дампов хранить (default 20)
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/root/sewing}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-sewing-prod}"
ENV_FILE="${ENV_FILE:-.env.prod}"

# Compose-файлы для prod. Порядок важен: base первым, потом prod (override).
COMPOSE_FILES=(
  -f docker-compose.base.yml
  -f docker-compose.prod.yml
)

# Базовый docker compose invocation (project + compose-файлы + env-file).
# Определён здесь (а не внутри шага «up»), чтобы pre-deploy backup на
# шаге 2 тоже мог им пользоваться.
DC_BASE=(docker compose -p "${COMPOSE_PROJECT}" "${COMPOSE_FILES[@]}" --env-file "${ENV_FILE}")

# Pre-deploy backup БД.
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-20}"

# Healthcheck:
#   - api НЕ публикуется на host-порт (8081 убран при вводе reverse proxy,
#     см. docker-compose.prod.yml: api только `expose: 3001`). Поэтому
#     healthcheck идёт через nginx на :443 с Host прод-домена — это
#     проверяет связку nginx + api целиком, как видит её пользователь.
#   - 401 UNAUTHENTICATED — корректный ответ /api/auth/me без cookie.
#   - 200 — если CI/админ уже залогинен, тоже ок.
PROD_HOST="${PROD_HOST:-prod.teeon.ru}"
API_HEALTH_URL="${API_HEALTH_URL:-https://127.0.0.1/api/auth/me}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_DELAY_S="${HEALTH_DELAY_S:-2}"

log() { printf '\n[deploy-prod] %s\n' "$*"; }

# -----------------------------------------------------------------------------
# 0. Sanity / cwd
# -----------------------------------------------------------------------------
if [ ! -d "${REPO_ROOT}/.git" ]; then
  echo "[deploy-prod] FATAL: ${REPO_ROOT} is not a git checkout" >&2
  exit 1
fi
cd "${REPO_ROOT}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "[deploy-prod] FATAL: ${ENV_FILE} not found in ${REPO_ROOT}" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Git fetch + checkout + ff-only pull
#
# `--ff-only` гарантирует, что мы НЕ создадим merge-commit на сервере;
# если локальная HEAD разъехалась с origin/main — деплой упадёт, и
# оператор должен разобраться руками. Это намеренно.
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
# 2. Pre-deploy DB backup (ДО любых изменений схемы)
#
# Снимаем gzip-дамп прод-БД до `compose up` и `migrate deploy`, чтобы при
# сломанной миграции был свежий restore-point. Если db-контейнер ещё не
# поднят (самый первый деплой на чистом сервере — терять нечего), шаг
# пропускается с предупреждением. Любой сбой pg_dump на работающей БД
# валит деплой (set -euo pipefail): миграции без бэкапа не катаем.
# Отключить точечно: SKIP_BACKUP=1.
# -----------------------------------------------------------------------------
if [ "${SKIP_BACKUP:-0}" = "1" ]; then
  log "SKIP_BACKUP=1 → пропускаем pre-deploy backup БД"
else
  DB_CID="$("${DC_BASE[@]}" ps -q db 2>/dev/null || true)"
  if [ -z "${DB_CID}" ] || \
     [ "$(docker inspect -f '{{.State.Running}}' "${DB_CID}" 2>/dev/null || echo false)" != "true" ]; then
    log "WARN: db-контейнер не запущен — пропускаю pre-deploy backup (чистая установка?)"
  else
    mkdir -p "${BACKUP_DIR}"
    BACKUP_FILE="${BACKUP_DIR}/prod_$(date +%Y%m%d_%H%M%S)_predeploy_${GIT_COMMIT_SHORT}.sql.gz"
    log "pre-deploy backup → ${BACKUP_FILE}"
    # POSTGRES_USER=user / POSTGRES_DB=myapp зашиты в docker-compose.base.yml.
    "${DC_BASE[@]}" exec -T db pg_dump -U user -d myapp --no-owner --no-privileges \
      | gzip > "${BACKUP_FILE}"
    if [ ! -s "${BACKUP_FILE}" ] || ! gzip -t "${BACKUP_FILE}"; then
      echo "[deploy-prod] FATAL: pre-deploy backup пустой или битый: ${BACKUP_FILE}" >&2
      exit 1
    fi
    log "backup OK ($(du -h "${BACKUP_FILE}" | cut -f1))"
    # Ротация: оставляем только BACKUP_KEEP свежих predeploy-дампов.
    ls -1t "${BACKUP_DIR}"/prod_*_predeploy_*.sql.gz 2>/dev/null \
      | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f || true
  fi
fi

# -----------------------------------------------------------------------------
# 3. Docker compose build + up
# -----------------------------------------------------------------------------
log "docker compose build"
"${DC_BASE[@]}" build

log "docker compose up -d --remove-orphans"
"${DC_BASE[@]}" up -d --remove-orphans

# -----------------------------------------------------------------------------
# 3.5 nginx reload (re-resolve upstream IPs)
#
# `build` пересобирает образы web/api → `up -d` ПЕРЕСОЗДАЁТ их контейнеры и
# docker выдаёт им новые IP (нередко web и api меняются местами в подсети).
# nginx-контейнер при этом не меняется и не пересоздаётся, а upstream-блоки
# (prod_web_upstream / prod_api_upstream в nginx.conf) резолвят хост ОДИН раз
# на старте конфига и кэшируют IP навсегда (open-source nginx без `resolve`).
# Итог: после деплоя весь трафик уходит в перепутанные контейнеры на чужие
# порты → connection refused → 502 на всём сайте, пока кто-то вручную не
# сделает reload. `nginx -s reload` перечитывает конфиг и перерезолвит хосты.
#
# Делаем ДО healthcheck (шаг 6 идёт через nginx) и только если nginx запущен
# и конфиг валиден. Best-effort: если nginx по какой-то причине не поднят,
# не валим деплой здесь — это поймает healthcheck.
# -----------------------------------------------------------------------------
NGINX_CID="$("${DC_BASE[@]}" ps -q nginx 2>/dev/null || true)"
if [ -n "${NGINX_CID}" ] && \
   [ "$(docker inspect -f '{{.State.Running}}' "${NGINX_CID}" 2>/dev/null || echo false)" = "true" ]; then
  if "${DC_BASE[@]}" exec -T nginx nginx -t >/dev/null 2>&1; then
    log "nginx -s reload (re-resolve upstream IPs after web/api recreate)"
    "${DC_BASE[@]}" exec -T nginx nginx -s reload || \
      log "WARN: nginx reload не удался — проверит healthcheck ниже"
  else
    log "WARN: nginx -t провалился — пропускаю reload (конфиг невалиден)"
  fi
else
  log "WARN: nginx-контейнер не запущен — пропускаю reload"
fi

# -----------------------------------------------------------------------------
# 4. Prisma migrations (внутри контейнера api)
#
# `prisma migrate deploy` — ЕДИНСТВЕННЫЙ авторитетный путь схемы на prod
# (PRISMA_AUTO_SYNC=0 в .env.prod: entrypoint больше НЕ делает db push и
# схему молча не «чинит»). Поэтому падение миграции = ОСТАНОВКА деплоя:
# сломанная миграция должна быть видна сразу, а не маскироваться. Бэкап
# уже снят на шаге 2 — restore-point есть, разбирается оператор
# (docs/deploy-ci-cd.md §«Migrations» + `prisma migrate status`).
# Точечно пропустить миграции (на свой риск): SKIP_MIGRATIONS=1.
# -----------------------------------------------------------------------------
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  log "prisma migrate deploy (inside api container)"
  if ! "${DC_BASE[@]}" exec -T api npx prisma migrate deploy --schema=prisma/schema.prisma; then
    echo "[deploy-prod] FATAL: prisma migrate deploy failed — деплой остановлен." >&2
    echo "[deploy-prod] Схема НЕ синхронизирована (db push отключён, PRISMA_AUTO_SYNC=0)." >&2
    echo "[deploy-prod] Разбор: 'prisma migrate status' + docs/deploy-ci-cd.md §Migrations." >&2
    echo "[deploy-prod] Restore-point: backups/prod_*_predeploy_${GIT_COMMIT_SHORT}.sql.gz" >&2
    exit 1
  fi
else
  log "SKIP_MIGRATIONS=1 → пропускаем prisma migrate deploy"
fi

# -----------------------------------------------------------------------------
# 5. Status: containers + recent logs (best-effort)
# -----------------------------------------------------------------------------
log "docker compose ps"
"${DC_BASE[@]}" ps

log "recent api logs (last 30 lines, best-effort)"
"${DC_BASE[@]}" logs --tail=30 api 2>&1 || true

log "recent web logs (last 30 lines, best-effort)"
"${DC_BASE[@]}" logs --tail=30 web 2>&1 || true

# -----------------------------------------------------------------------------
# 6. Healthcheck
#
# Принимаем 200 (есть валидная сессия) ИЛИ 401 (анонимный запрос — ожидаемо).
# Любые 5xx, connection refused, timeout — ошибка деплоя.
# -----------------------------------------------------------------------------
log "healthcheck: ${API_HEALTH_URL} (Host: ${PROD_HOST}, accept 200 or 401)"
attempt=0
while :; do
  attempt=$((attempt + 1))
  # -k: cert выписан на ${PROD_HOST}, а стучимся в 127.0.0.1 (loopback).
  # -H Host: nginx роутит по server_name на нужный vhost.
  status="$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: ${PROD_HOST}" "${API_HEALTH_URL}" || echo '000')"
  case "${status}" in
    200|401)
      log "API healthy: HTTP ${status}"
      break
      ;;
    *)
      if [ "${attempt}" -ge "${HEALTH_ATTEMPTS}" ]; then
        echo "[deploy-prod] FATAL: API not healthy after ${attempt} attempts (last status: ${status})" >&2
        exit 1
      fi
      echo "  attempt ${attempt}/${HEALTH_ATTEMPTS} — got ${status}, retry in ${HEALTH_DELAY_S}s"
      sleep "${HEALTH_DELAY_S}"
      ;;
  esac
done

log "DEPLOY PROD OK — commit ${GIT_COMMIT_SHORT} on branch ${DEPLOY_BRANCH}"
