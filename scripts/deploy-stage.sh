#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# deploy-stage.sh — repeatable production-grade деплой stage-окружения SEWING.
#
# Заменяет ручной флоу `fuser -k + nohup`:
#   - сначала всегда делается backup БД (на случай миграции с потерей данных);
#   - билд/typecheck идут до рестарта сервисов: если что-то сломалось,
#     старая версия продолжает работать;
#   - сервисы перезапускаются через systemd (sewing-api, sewing-web);
#   - сразу после `systemctl start` каждого юнита скрипт ждёт, пока сервис
#     реально откроет TCP-порт (а не просто перешёл в `active (running)`).
#     Без этого wait-loop healthcheck иногда срабатывал раньше, чем
#     Next.js успевал забиндить :3000, и `curl -I http://127.0.0.1:3000`
#     валился на «Failed to connect» при формально живом юните;
#   - если ожидание не прошло за лимит, скрипт печатает systemctl status,
#     последние 120 строк journalctl и снимок ss по портам 3000/3001.
#
# Любая ошибка любого шага — exit 1 (set -euo pipefail). Никаких
# «продолжим, авось взлетит».
#
# Запуск:
#   sudo bash /sewing/scripts/deploy-stage.sh
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3001/api/health}"
WEB_HEALTH_URL="${WEB_HEALTH_URL:-http://127.0.0.1:3000}"
API_UNIT="${API_UNIT:-sewing-api}"
WEB_UNIT="${WEB_UNIT:-sewing-web}"
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-30}"
WAIT_DELAY="${WAIT_DELAY:-1}"

log() { printf '\n[deploy-stage] %s\n' "$*"; }

# -----------------------------------------------------------------------------
# Helpers: wait_for_http_*
#
# Два варианта намеренно разнесены, потому что у API и WEB разные семантики:
#
#   - API `/api/health` — это явный health-эндпоинт, он обязан отдавать 200.
#     Если он отдал 4xx/5xx, это уже проблема (например, БД недоступна), и
#     мы хотим чтобы deploy на этом упал → используем `curl -fsS` с -f.
#
#   - WEB `/` под Next.js на stage может редиректить на /login (3xx) или
#     отдавать 4xx, если cookie ещё не выставлены. С `-f` curl бы упал на
#     этом сценарии и мы бы решили, что web лежит, хотя на самом деле он
#     уже ответил по TCP. Нам тут важно ровно одно: listener поднят и
#     отдаёт хоть какой-то HTTP-ответ → используем `curl -sS` без -f.
#
# Цикл сделан через `if curl ...; then` — это безопасно при `set -e`,
# негативный исход первой попытки НЕ убивает скрипт.
# -----------------------------------------------------------------------------

wait_for_http_200() {
  local name="$1"
  local url="$2"
  local attempts="${3:-${WAIT_ATTEMPTS}}"
  local delay="${4:-${WAIT_DELAY}}"
  local i

  log "waiting for ${name}: ${url} (HTTP 200, до ${attempts}×${delay}s)"

  for i in $(seq 1 "${attempts}"); do
    if curl -fsS -I --max-time 5 "${url}" >/dev/null 2>&1; then
      log "${name} is healthy: ${url}"
      return 0
    fi
    echo "  ${name} not healthy yet (${i}/${attempts})"
    sleep "${delay}"
  done

  echo "[deploy-stage] ${name} did not become healthy: ${url}" >&2
  return 1
}

wait_for_http_head_any_status() {
  local name="$1"
  local url="$2"
  local attempts="${3:-${WAIT_ATTEMPTS}}"
  local delay="${4:-${WAIT_DELAY}}"
  local i

  log "waiting for ${name}: ${url} (любой HTTP-ответ, до ${attempts}×${delay}s)"

  for i in $(seq 1 "${attempts}"); do
    if curl -sS -I --max-time 5 "${url}" >/dev/null 2>&1; then
      log "${name} is responding: ${url}"
      return 0
    fi
    echo "  ${name} not ready yet (${i}/${attempts})"
    sleep "${delay}"
  done

  echo "[deploy-stage] ${name} did not respond: ${url}" >&2
  return 1
}

# -----------------------------------------------------------------------------
# dump_unit_diagnostics — диагностика для случая, когда wait-loop не дождался
# ответа. Сюда попадаем только из ветки ошибки, поэтому осознанно глушим
# собственные падения (`|| true`): первичная ошибка — это «${unit} не
# поднялся», и мы не хотим, чтобы её затёр fail в journalctl/ss.
# -----------------------------------------------------------------------------
dump_unit_diagnostics() {
  local unit="$1"
  echo "[deploy-stage] === diagnostics for ${unit} ===" >&2
  systemctl status "${unit}" --no-pager -l || true
  journalctl -u "${unit}" -n 120 --no-pager -l || true
  echo "[deploy-stage] ss listeners на 3000/3001:" >&2
  ss -ltnp 2>/dev/null | grep -E '3000|3001' || true
  echo "[deploy-stage] === end diagnostics for ${unit} ===" >&2
}

# 0. sanity: systemd-юниты должны быть установлены (install-systemd.sh).
if ! systemctl list-unit-files "${API_UNIT}.service" "${WEB_UNIT}.service" \
      --no-legend 2>/dev/null | grep -q "${API_UNIT}.service"; then
  echo "[deploy-stage] юниты ${API_UNIT}/${WEB_UNIT} не установлены." >&2
  echo "[deploy-stage] сначала: sudo bash scripts/install-systemd.sh" >&2
  exit 1
fi

# 1. Pre-deploy backup. Если бэкап упал — деплой не начинаем.
log "step 1/9: pre-deploy backup PostgreSQL"
backup_path="$(bash "${REPO_ROOT}/scripts/backup-db.sh" | tail -n 1)"
log "backup создан: ${backup_path}"

# 2. Зависимости. package-lock.json есть в репо → используем npm ci
#    (детерминированная установка, чистит node_modules).
log "step 2/9: install deps"
if [[ -f "${REPO_ROOT}/package-lock.json" ]]; then
  npm ci --no-audit --fund=false
else
  echo "[deploy-stage] WARN: package-lock.json отсутствует, fallback на npm install" >&2
  npm install --no-audit --fund=false
fi

# 3. Typecheck — отдельным шагом, чтобы tsc-ошибки не маскировались
#    более общим build (next build не всегда падает на типах в shared).
log "step 3/9: typecheck"
npm run typecheck

# 4. Build (api + web через workspaces).
log "step 4/9: build"
npm run build

# 5. Миграции БД. `migrate deploy` — production-safe вариант (не пытается
#    переписывать историю, только применяет pending-миграции).
log "step 5/9: prisma migrate deploy"
npx prisma migrate deploy --schema=prisma/schema.prisma

# 6. Cleanup + рестарт API/WEB.
#
#    Раньше тут было два честных `systemctl restart`. Это ломалось при
#    переходе со старого nohup-флоу: на портах 3000/3001 могли висеть
#    осиротевшие процессы (см. scripts/cleanup-legacy-processes.sh),
#    из-за которых только что стартовавший systemd-юнит ловил EADDRINUSE
#    и уходил в Restart-loop.
#
#    Чтобы deploy был детерминированным, сейчас делаем:
#      a) cleanup-script глушит юниты + чистит порты (он же
#         идемпотентен — на «чистой» машине это просто stop+start);
#      b) поднимаем юниты заново через `systemctl start` (а не restart,
#         потому что cleanup их уже остановил), и СРАЗУ после старта
#         каждого юнита ждём, пока он реально начнёт отвечать по HTTP.
#
#    Цена: stage-deploy НЕ zero-downtime — между cleanup и start есть
#    окно ~1–2с, когда оба сервиса лежат. Для stage это допустимо;
#    zero-downtime — отдельная задача (см. docs/ops.md §8).
log "step 6/9: cleanup legacy/занятых портов 3000/3001"
bash "${REPO_ROOT}/scripts/cleanup-legacy-processes.sh"

# 7. Старт сервисов + ожидание готовности.
#
#    Раньше тут был мгновенный `curl -I http://127.0.0.1:3000` сразу после
#    `systemctl start sewing-web`, и он стабильно валился на «Failed to
#    connect to 127.0.0.1 port 3000», потому что Next.js успевал перейти в
#    `active (running)` за ~20ms, но листенер на :3000 поднимался ещё
#    несколько секунд. Сейчас порядок такой:
#      - старт API → wait_for_http_200 на /api/health (200 обязателен);
#      - старт WEB → wait_for_http_head_any_status на :3000 (нам важно,
#        что listener поднят, а 200/302/4xx — детали).
#    Если ожидание не прошло, печатаем диагностику и падаем с exit 1.
log "step 7/9: start ${API_UNIT} → wait → start ${WEB_UNIT} → wait"

systemctl start "${API_UNIT}"
if ! wait_for_http_200 "api" "${API_HEALTH_URL}" "${WAIT_ATTEMPTS}" "${WAIT_DELAY}"; then
  dump_unit_diagnostics "${API_UNIT}"
  exit 1
fi

systemctl start "${WEB_UNIT}"
if ! wait_for_http_head_any_status "web" "${WEB_HEALTH_URL}" "${WAIT_ATTEMPTS}" "${WAIT_DELAY}"; then
  dump_unit_diagnostics "${WEB_UNIT}"
  exit 1
fi

# 8. Финальные информационные curl-и. Они выполняются УЖЕ после wait-loop,
#    то есть на момент этого вывода оба сервиса гарантированно слушают
#    порты — в отличие от старого варианта, где curl бил по сокету раньше,
#    чем Next.js успевал к нему привязаться.
log "step 8/9: финальные HTTP-проверки (после wait-loop)"
curl -I --max-time 5 "${API_HEALTH_URL}" || true
curl -I --max-time 5 "${WEB_HEALTH_URL}" || true

# 8b. Опциональная подсказка: показать оператору, как проверить
#     /uploads/* (превью лекал) после деплоя. Сам curl сюда мы не
#     включаем, потому что:
#       а) на чистой stage-машине каталог uploads может быть пустым
#          (легитимный кейс — никто ещё не залил лекало) и find ничего
#          не вернёт → мы получим ложный fail;
#       б) проверка от 127.0.0.1:3001 ничего не говорит про nginx,
#          а проверка через домен требует https + DNS, которые в этой
#          скрипт-обёртке не проверяются.
#     Подробности — docs/deploy-uploads-static-routing.md.
UPLOADS_DIR="${PATTERNS_UPLOADS_DIR:-${REPO_ROOT}/apps/api/uploads}"
log "uploads routing check (опционально, не падаем):"
if [[ -d "${UPLOADS_DIR}" ]]; then
  sample_file="$(find "${UPLOADS_DIR}" -type f 2>/dev/null | head -n 1 || true)"
  if [[ -n "${sample_file}" ]]; then
    sample_url="/uploads${sample_file#${UPLOADS_DIR}}"
    echo "  curl -I http://127.0.0.1:3001${sample_url}     # ожидаем 200"
    echo "  curl -I https://stage.teeon.ru${sample_url}    # ожидаем 200 после nginx"
  else
    echo "  (uploads пустой — проверять нечем; см. docs/deploy-uploads-static-routing.md)"
  fi
else
  echo "  WARN: ${UPLOADS_DIR} не существует — проверьте PATTERNS_UPLOADS_DIR"
fi

# 9. Финальный отчёт.
log "step 9/9: status"
echo "  ${API_UNIT}: $(systemctl is-active "${API_UNIT}")"
echo "  ${WEB_UNIT}: $(systemctl is-active "${WEB_UNIT}")"

log "journalctl ${API_UNIT} (последние 80 строк):"
journalctl -u "${API_UNIT}" -n 80 --no-pager || true

log "journalctl ${WEB_UNIT} (последние 80 строк):"
journalctl -u "${WEB_UNIT}" -n 80 --no-pager || true

log "DEPLOY OK — backup: ${backup_path}"
