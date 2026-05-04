'use client';

/**
 * Кнопка «Мой QR-код» + модальное окно с QR для сотрудника.
 *
 * Контракт UX (см. `docs/screens.md §«Мой QR-код»`):
 *   - Размещение: на всех рабочих экранах, где видна `RoleHeaderCard`
 *     (`/work`, `/qc`, `/wto`, `/packing`), а также на `/master` и
 *     как самостоятельный элемент в иных layout'ах, где она нужна.
 *   - Клик — лениво грузит `/api/me/employee-qr` через server action
 *     (`getMyEmployeeQrAction`, см. `app/employee-qr/actions.ts`),
 *     открывает модалку и рендерит QR локально из `qrPayload`
 *     (`qrcode.react`). Внешние QR-API не используем — данные
 *     подписаны секретом API, не должны покидать периметр.
 *   - Пока запрос идёт — показываем «Загрузка…»; при ошибке —
 *     фиксированный текст из ТЗ + inline-сообщение с `requestId`,
 *     чтобы пилоту было что назвать поддержке.
 *
 * RBAC:
 *   Сам компонент-кнопка доступа не режет — вызывающий (layout,
 *   header, `/master`) сам вызывает `canSeeEmployeeQrButton(role)`
 *   из `lib/rbac.ts`. Это упрощает переиспользование: кнопка — UI
 *   примитив, а «кому показывать» — политика, решаемая снаружи.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
<<<<<<< HEAD
import { QRCodeCanvas } from 'qrcode.react';
import type { EmployeeQrResponseDto } from '@sewing/shared/employee-qr';
import { getMyEmployeeQrAction } from '@/app/employee-qr/actions';
=======
import type { EmployeeQrResponseDto } from '@sewing/shared/employee-qr';
import { getMyEmployeeQrAction } from '@/app/employee-qr/actions';
import { QrCodeView } from '@/components/qr';
>>>>>>> 88554a2aa2955493b346a1883607fb420def843e

export interface EmployeeQrButtonProps {
  /**
   * Визуальный стиль кнопки. `inline` — компактная кнопка внутри
   * шапки/карточки; `floating` (default) — крупная, хорошо читается
   * на мобильных терминалах и не конкурирует с другими FAB'ами на
   * странице.
   */
  variant?: 'inline' | 'floating';
  /** Дополнительный CSS-класс на корневой кнопке. */
  className?: string;
}

export function EmployeeQrButton({
  variant = 'inline',
  className,
}: EmployeeQrButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<EmployeeQrResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const openBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorRequestId(null);
    const res = await getMyEmployeeQrAction();
    if (res.ok) {
      setData(res.data);
    } else {
      setData(null);
      setError(res.error);
      setErrorRequestId(res.errorRequestId ?? null);
    }
    setLoading(false);
  }, []);

  const onOpen = useCallback(() => {
    setOpen(true);
    // Каждый раз загружаем заново: токен короткоживущий, а
    // пользователь мог держать страницу открытой дольше TTL.
    void load();
  }, [load]);

  const onClose = useCallback(() => {
    setOpen(false);
    setData(null);
    setError(null);
    setErrorRequestId(null);
    // Возвращаем фокус на ту кнопку, с которой открыли модалку —
    // так работает штатная accessibility-модель dialog'а.
    openBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const btnClass = [
    'employee-qr-btn',
    variant === 'floating'
      ? 'employee-qr-btn--fab'
      : 'employee-qr-btn--inline',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={openBtnRef}
        type="button"
        className={btnClass}
        onClick={onOpen}
        data-testid="employee-qr-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Открыть мой QR-код"
      >
        <span className="employee-qr-btn__icon" aria-hidden="true">
          ▦
        </span>
        <span className="employee-qr-btn__label">Мой QR-код</span>
      </button>

      {open ? (
        <div
          className="qr-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          data-testid="employee-qr-modal"
        >
          <div className="qr-modal__card employee-qr-modal__card">
            <div className="qr-modal__header">
              <h3 className="qr-modal__title" id={titleId}>
                QR-код сотрудника
              </h3>
              <button
                type="button"
                className="qr-modal__close"
                onClick={onClose}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>

            {loading ? (
              <p className="qr-modal__hint">Загрузка…</p>
            ) : error ? (
              <div className="qr-modal__error" role="alert">
                <p className="qr-modal__error-title">
                  Не удалось загрузить QR-код. Попробуйте ещё раз.
                </p>
                <p className="qr-modal__hint">{error}</p>
                {errorRequestId ? (
                  <p className="qr-modal__hint qr-modal__hint--mono">
                    request-id: {errorRequestId}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn btn-block employee-qr-modal__retry"
                  onClick={() => void load()}
                  data-testid="employee-qr-retry"
                >
                  Повторить
                </button>
              </div>
            ) : data ? (
              <div className="employee-qr-modal__body">
<<<<<<< HEAD
                <div
                  className="employee-qr-modal__canvas"
                  data-testid="employee-qr-canvas"
                >
                  <QRCodeCanvas
                    value={data.qrPayload}
                    size={240}
                    level="M"
                    includeMargin
                    aria-label="QR-код сотрудника"
                  />
                </div>
=======
                <QrCodeView
                  value={data.qrPayload}
                  size={240}
                  title="QR-код сотрудника"
                  className="employee-qr-modal__canvas"
                />

>>>>>>> 88554a2aa2955493b346a1883607fb420def843e
                <div className="employee-qr-modal__meta">
                  <p className="employee-qr-modal__name">
                    {data.employee.name}
                  </p>
                  <p className="employee-qr-modal__role">{data.employee.role}</p>
                </div>
                <p className="qr-modal__hint">
                  {'Покажите этот код мастеру или отсканируйте на рабочем терминале'}
                </p>
              </div>
            ) : null}

            <button
              type="button"
              className="btn btn-block qr-modal__cancel"
              onClick={onClose}
            >
              Закрыть
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
