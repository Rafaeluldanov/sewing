#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# cleanup-legacy-processes.sh — one-shot/idempotent cleanup для перехода
# с ручного `nohup node ...` на systemd-юниты sewing-api / sewing-web.
#
# Зачем нужен:
#   После перехода на systemd на stage остались живые nohup-процессы,
#   которые держали 3000 (next) и 3001 (api). systemd при старте получал
#   EADDRINUSE и уходил в Restart-loop, пока кто-то руками не делал
#       fuser -k 3000/tcp ; fuser -k 3001/tcp
#   Этот скрипт упаковывает безопасный, повторяемый cleanup, который:
#     1) сначала глушит сами sewing-* юниты (иначе systemd тут же
#        перезапустит процесс, который мы только что убили);
#     2) убивает только процессы, которые держат ровно :3000/:3001;
#     3) дополнительно гасит сирот по узким pkill-паттернам
#        (apps/api/dist/main.js, next start apps/web), а НЕ по широкому
#        "node" — иначе можно зацепить, например, prisma или ci;
#     4) даёт ядру 1 секунду закрыть сокеты и печатает ss-снимок,
#        чтобы было видно: порты пустые или их кто-то ещё держит.
#
# Скрипт НЕ стартует сервисы. Запуск — задача install-systemd.sh или
# deploy-stage.sh, иначе мы дважды стартуем юниты в разных контекстах
# и теряем гарантии stop/start ordering.
#
# Идемпотентен: можно запускать в любой момент, отсутствие процессов
# не считается ошибкой (`|| true`).
#
# Запуск:
#   sudo bash /sewing/scripts/cleanup-legacy-processes.sh
# -----------------------------------------------------------------------------

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

API_UNIT="${API_UNIT:-sewing-api}"
WEB_UNIT="${WEB_UNIT:-sewing-web}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"

log() { printf '[cleanup-legacy] %s\n' "$*"; }

# 1. Гасим юниты ПЕРВЫМИ. Если этого не сделать, systemd увидит, что
#    main-процесс умер, и поднимет его за RestartSec=5 — и мы окажемся
#    в гонке "убил → systemd воскресил → fuser снова убил".
log "stop ${API_UNIT} ${WEB_UNIT} (если запущены)"
systemctl stop "${API_UNIT}" "${WEB_UNIT}" 2>/dev/null || true

# 2. Убиваем держателей именно этих портов. fuser -k шлёт SIGKILL по
#    дефолту — для legacy nohup-процесса это ок: graceful нам тут не
#    нужен, мы и так уходим в полный рестарт.
#    Postgres (5432) и nginx (80/443) портов 3000/3001 не держат —
#    зацепить их этим вызовом нельзя.
log "fuser -k ${WEB_PORT}/tcp"
fuser -k "${WEB_PORT}/tcp" 2>/dev/null || true
log "fuser -k ${API_PORT}/tcp"
fuser -k "${API_PORT}/tcp" 2>/dev/null || true

# 3. Подчистка по узким паттернам — на случай, если процесс уже
#    отпустил порт (TIME_WAIT) или висит на другом порту, но это
#    всё ещё наш legacy. Узкие паттерны критичны: pkill -f "node"
#    зацепил бы prisma, tsx, npm-сабпроцессы, ci-runner и т.п.
log "pkill apps/api/dist/main.js (legacy nohup api)"
pkill -f "apps/api/dist/main.js" 2>/dev/null || true
log "pkill next start apps/web (legacy nohup web)"
pkill -f "next start apps/web" 2>/dev/null || true

# 4. Даём ядру закрыть TCP-сокеты и снять FIN_WAIT/TIME_WAIT с listener.
#    Без этого следующий же `systemctl start` иногда ловит EADDRINUSE
#    на быстрых машинах.
sleep 1

# 5. Диагностика. Не падаем, если grep ничего не нашёл — это и есть
#    success-кейс ("ports free").
log "статус портов:"
if ss -ltnp 2>/dev/null | grep -E ":(${WEB_PORT}|${API_PORT})\b"; then
  log "WARN: порты ${WEB_PORT}/${API_PORT} всё ещё заняты — см. вывод ss выше"
else
  log "ports free (${WEB_PORT}, ${API_PORT})"
fi
