#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# install-systemd.sh — устанавливает/обновляет systemd-юниты SEWING.
#
# Идемпотентен: можно запускать сколько угодно раз. На каждом прогоне:
#   1. cmp с уже установленным юнитом — если не изменился, не трогаем
#      (важно, чтобы не перезапускать сервисы зря и не плодить шум в
#      journalctl);
#   2. при изменении — копируем, daemon-reload, restart;
#   3. enable выполняется всегда (no-op, если уже enabled).
#
# Запускать строго от root:
#   sudo bash /sewing/scripts/install-systemd.sh
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/deploy/systemd"
DST_DIR="/etc/systemd/system"
UNITS=(sewing-api.service sewing-web.service)

if [[ "${EUID}" -ne 0 ]]; then
  echo "[install-systemd] требуется root (sudo bash $0)" >&2
  exit 1
fi

if [[ ! -d "${SRC_DIR}" ]]; then
  echo "[install-systemd] не найден ${SRC_DIR}" >&2
  exit 1
fi

changed=0
for unit in "${UNITS[@]}"; do
  src="${SRC_DIR}/${unit}"
  dst="${DST_DIR}/${unit}"

  if [[ ! -f "${src}" ]]; then
    echo "[install-systemd] missing source: ${src}" >&2
    exit 1
  fi

  if [[ -f "${dst}" ]] && cmp -s "${src}" "${dst}"; then
    echo "[install-systemd] ${unit}: без изменений"
  else
    echo "[install-systemd] ${unit}: обновляю ${dst}"
    install -m 0644 -o root -g root "${src}" "${dst}"
    changed=1
  fi
done

if [[ "${changed}" -eq 1 ]]; then
  echo "[install-systemd] systemctl daemon-reload"
  systemctl daemon-reload
fi

# enable идемпотентен — повторный вызов на уже enabled-юните это no-op.
echo "[install-systemd] enable units"
systemctl enable "${UNITS[@]}"

# restart всегда: гарантирует, что бежит именно текущая сборка
# /sewing/apps/api/dist/main.js и .next. Если юниты не менялись и
# процессы здоровы — это просто короткая просадка ~1s.
echo "[install-systemd] restart units"
systemctl restart "${UNITS[@]}"

echo "[install-systemd] статус:"
systemctl status --no-pager --lines=0 "${UNITS[@]}" || true

# Подсказка для one-time перехода с nohup-флоу. Не делаем cleanup здесь
# автоматически: install-systemd.sh может запускаться на чистой машине,
# и лишний fuser -k там бессмысленен. На machine, где остались legacy
# nohup-процессы, оператор увидит EADDRINUSE в journalctl и запустит
# cleanup явно.
echo "[install-systemd] если в journalctl видно EADDRINUSE на :3000/:3001"
echo "[install-systemd]   (например, после первого перехода с nohup на systemd) —"
echo "[install-systemd]   запустите: sudo bash ${REPO_ROOT}/scripts/cleanup-legacy-processes.sh"
