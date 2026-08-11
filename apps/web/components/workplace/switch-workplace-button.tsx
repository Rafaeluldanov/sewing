'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, QrCode, Repeat, X } from 'lucide-react';
import type { MyWorkplaceDto } from '@sewing/shared/workplace';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import { getPrimaryWorkspace } from '@/lib/rbac';
import {
  loadMyWorkplacesAction,
  switchWorkplaceAction,
  type SwitchWorkplaceActionResult,
  type SwitchWorkplaceTarget,
} from './switch-workplace-action';

/**
 * Кнопка «Сменить участок» (фича «несколько ролей», 18.06.2026;
 * шторка со списком — 11.08.2026).
 *
 * Рендерится в RootLayout для сотрудников с 2+ НАЗНАЧЕННЫМИ участками
 * — одна на всё приложение, поэтому переключение выглядит одинаково в
 * любом кабинете (`/work`, `/qc`, `/wto`, `/packing`, `/cutter`).
 *
 * По клику открывается шторка со списком участков сотрудника
 * (`GET /api/me/workplaces`): выбор строки переключает сразу. Скан QR
 * рабочего места остался равноправным вторым путём — он дополнительно
 * называет конкретный станок, а кому-то просто привычнее подойти и
 * отсканировать.
 *
 * Оба пути ведут в один и тот же серверный переход: при незавершённой
 * работе backend просит подтверждение (`confirmRequired`) — показываем
 * диалог и повторяем с `force`. После успеха ведём на рабочий экран
 * нового участка (`getPrimaryWorkspace`) и обновляем RSC.
 *
 * Отказ печатаем ВНУТРИ шторки (`.workplace-switch-sheet__error`), а не
 * только тостом: шторка `fixed` и перекрывает страницу — сообщение под
 * ней читается как «кнопка не сработала» (см. тот же класс багов в
 * `master-actions-sheet`).
 */
export function SwitchWorkplaceButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<SwitchWorkplaceTarget | null>(null);
  const [rows, setRows] = useState<MyWorkplaceDto[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Список грузим по открытию шторки: RootLayout рендерится на каждой
  // странице, тянуть участки заранее — лишний запрос в горячем пути.
  useEffect(() => {
    if (!open || rows || loading) return;
    setLoading(true);
    void loadMyWorkplacesAction()
      .then((res) => {
        if (res.ok) setRows(res.rows);
        else setError(res.error);
      })
      .finally(() => setLoading(false));
  }, [open, rows, loading]);

  function goToRole(role: string) {
    setOpen(false);
    router.push(getPrimaryWorkspace(role));
    router.refresh();
  }

  function handleResult(
    result: SwitchWorkplaceActionResult,
    target: SwitchWorkplaceTarget,
  ) {
    if (result.ok) {
      setPending(null);
      goToRole(result.ok.role);
      return;
    }
    if (result.confirmRequired) {
      // Незавершённая работа — спрашиваем подтверждение и запоминаем цель.
      setPending(target);
      return;
    }
    setError(result.error ?? 'Не удалось сменить участок');
  }

  async function run(target: SwitchWorkplaceTarget, force: boolean) {
    setError(null);
    setBusy(true);
    try {
      handleResult(await switchWorkplaceAction(target, force), target);
    } finally {
      setBusy(false);
    }
  }

  async function onScan(code: string) {
    setScanning(false);
    await run({ code }, false);
  }

  return (
    <>
      <button
        type="button"
        className="workplace-switch-fab"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={busy}
        aria-label="Сменить участок"
      >
        <Repeat size={18} strokeWidth={1.8} aria-hidden />
        <span>{busy ? 'Переключаем…' : 'Сменить место'}</span>
      </button>

      {open && (
        <div
          className="workplace-switch-sheet__backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Сменить участок"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="workplace-switch-sheet">
            <div className="workplace-switch-sheet__head">
              <h2 className="workplace-switch-sheet__title">Сменить участок</h2>
              <button
                type="button"
                className="workplace-switch-sheet__close"
                onClick={() => setOpen(false)}
                aria-label="Закрыть"
              >
                <X size={18} strokeWidth={2} aria-hidden />
              </button>
            </div>

            {error && (
              <p className="workplace-switch-sheet__error" role="alert">
                {error}
              </p>
            )}

            {loading && !rows ? (
              <p className="workplace-switch-sheet__hint">Загружаем участки…</p>
            ) : null}

            {rows?.map((w) => (
              <button
                key={w.role}
                type="button"
                className={
                  'workplace-switch-sheet__row' +
                  (w.current ? ' is-current' : '')
                }
                onClick={() => {
                  if (w.current) {
                    setOpen(false);
                    return;
                  }
                  void run({ role: w.role }, false);
                }}
                disabled={busy}
              >
                <span className="workplace-switch-sheet__row-main">
                  <span className="workplace-switch-sheet__row-title">
                    {w.label}
                  </span>
                  {w.primary && !w.current ? (
                    <span className="workplace-switch-sheet__row-sub">
                      участок по умолчанию
                    </span>
                  ) : null}
                </span>
                {w.current ? (
                  <span className="workplace-switch-sheet__chip">
                    <Check size={13} strokeWidth={2.4} aria-hidden /> вы здесь
                  </span>
                ) : (
                  <span className="workplace-switch-sheet__row-go" aria-hidden>
                    ›
                  </span>
                )}
              </button>
            ))}

            <div className="workplace-switch-sheet__divider" />
            <button
              type="button"
              className="admin-btn admin-btn--ghost workplace-switch-sheet__scan"
              onClick={() => {
                setError(null);
                setScanning(true);
              }}
              disabled={busy}
            >
              <QrCode size={16} strokeWidth={1.8} aria-hidden />
              Сканировать QR рабочего места
            </button>
          </div>
        </div>
      )}

      {scanning && (
        <QrScannerModal
          hint="Наведите камеру на QR рабочего места."
          onScan={(code) => void onScan(code)}
          onClose={() => setScanning(false)}
        />
      )}

      {pending && (
        <div
          className="workplace-switch-confirm__backdrop"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPending(null);
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
                onClick={() => setPending(null)}
                disabled={busy}
              >
                Отмена
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={() => void run(pending, true)}
                disabled={busy}
              >
                {busy ? 'Переключаем…' : 'Закрыть смену и перейти'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && !open && (
        <div
          className="workplace-switch-toast"
          role="alert"
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </>
  );
}
