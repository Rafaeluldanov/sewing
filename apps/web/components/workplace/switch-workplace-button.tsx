'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Repeat } from 'lucide-react';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import { getPrimaryWorkspace } from '@/lib/rbac';
import {
  switchWorkplaceAction,
  type SwitchWorkplaceActionResult,
} from './switch-workplace-action';

/**
 * Кнопка «Сменить рабочее место» (фича «несколько ролей», 18.06.2026).
 *
 * Рендерится в RootLayout только для сотрудников с 2+ ролями. По клику
 * открывает QR-сканер; отсканировав QR рабочего места (`equipment:{id}`),
 * сотрудник переключается на терминал роли этого участка (если она
 * входит в его роли — backend проверяет). При незавершённой работе
 * backend просит подтверждение (`confirmRequired`) — показываем диалог
 * и повторяем с `force`. После успеха ведём на рабочий экран новой роли
 * (`getPrimaryWorkspace`) и обновляем RSC.
 */
export function SwitchWorkplaceButton() {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  function goToRole(role: string) {
    const target = getPrimaryWorkspace(role);
    router.push(target);
    router.refresh();
  }

  function handleResult(result: SwitchWorkplaceActionResult, code: string) {
    if (result.ok) {
      setPendingCode(null);
      goToRole(result.ok.role);
      return;
    }
    if (result.confirmRequired) {
      // Незавершённая работа — спрашиваем подтверждение и запоминаем код.
      setPendingCode(code);
      return;
    }
    setError(result.error ?? 'Не удалось сменить рабочее место');
  }

  async function onScan(code: string) {
    setScanning(false);
    setError(null);
    setBusy(true);
    try {
      const result = await switchWorkplaceAction(code, false);
      handleResult(result, code);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSwitch() {
    if (!pendingCode) return;
    setBusy(true);
    setError(null);
    try {
      const result = await switchWorkplaceAction(pendingCode, true);
      handleResult(result, pendingCode);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="workplace-switch-fab"
        onClick={() => {
          setError(null);
          setScanning(true);
        }}
        disabled={busy}
        aria-label="Сменить рабочее место"
      >
        <Repeat size={18} strokeWidth={1.8} aria-hidden />
        <span>{busy ? 'Переключаем…' : 'Сменить место'}</span>
      </button>

      {scanning && (
        <QrScannerModal
          onScan={(code) => void onScan(code)}
          onClose={() => setScanning(false)}
        />
      )}

      {pendingCode && (
        <div
          className="workplace-switch-confirm__backdrop"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingCode(null);
          }}
        >
          <div className="workplace-switch-confirm">
            <p className="workplace-switch-confirm__text">
              У вас есть незавершённая работа. Закрыть текущую смену и
              перейти на другой участок?
            </p>
            <div className="workplace-switch-confirm__actions">
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={() => setPendingCode(null)}
                disabled={busy}
              >
                Отмена
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={() => void confirmSwitch()}
                disabled={busy}
              >
                {busy ? 'Переключаем…' : 'Закрыть смену и перейти'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="workplace-switch-toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </>
  );
}
