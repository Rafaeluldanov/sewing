'use client';

import { useEffect, useId, type MouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ModalPortal } from '@/components/modal-portal';

/**
 * AdminModal — общий каркас overlay-модалки админки.
 *
 * Обобщает разметку семейства `.admin-size-plan-modal*` (globals.css),
 * которая до этого копипастилась по файлам (`create-size-modal`,
 * `start-order-sample-modal`, …): портал в `<body>` (ModalPortal),
 * backdrop с закрытием по клику мимо окна, header с заголовком и
 * крестиком, ESC-закрытие.
 *
 * `children` рендерятся как есть внутри диалога после header — модалка
 * с формой строит структуру сама (обычно
 * `<form>` → `.admin-size-plan-modal__body` + `__footer`), см.
 * `components/admin/ref-create/ref-modal-form.tsx`.
 *
 * ESC-слушатель навешивается в capture-фазе со `stopPropagation`:
 * модалка может открываться ПОВЕРХ другой модалки (например, «создать
 * поставщика» из окна заявки на оплату), у которой свой document-level
 * keydown в bubble-фазе — без capture один ESC закрыл бы оба слоя.
 * По этой же причине у вложенных сценариев поднимается `zIndex`
 * (базовый у `.admin-size-plan-modal__backdrop` — 80).
 *
 * Focus-trap и body-scroll-lock сознательно не делаются — как и во
 * всех остальных модалках проекта (см. docblock `modal-portal.tsx`).
 */
export interface AdminModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** Ширина окна в px; по умолчанию CSS-ные 420px. */
  width?: number;
  /** Поверх вложенных оверлеев (`spr-overlay` = 1000, `qr-modal` = 100). */
  zIndex?: number;
  /** Блокирует закрытие (крестик/ESC/backdrop) на время submit. */
  closeDisabled?: boolean;
  'data-testid'?: string;
}

export function AdminModal({
  title,
  subtitle,
  onClose,
  children,
  width,
  zIndex,
  closeDisabled = false,
  'data-testid': dataTestId,
}: AdminModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (closeDisabled) return;
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [closeDisabled, onClose]);

  function handleBackdropMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (closeDisabled) return;
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <ModalPortal>
      <div
        className="admin-size-plan-modal__backdrop"
        onMouseDown={handleBackdropMouseDown}
        style={zIndex !== undefined ? { zIndex } : undefined}
        data-testid={dataTestId}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="admin-size-plan-modal"
          style={
            width !== undefined
              ? { width: `min(${width}px, 100%)`, maxWidth: 'calc(100vw - 2rem)' }
              : undefined
          }
        >
          <header className="admin-size-plan-modal__header">
            <div className="admin-size-plan-modal__titles">
              <h3 id={titleId} className="admin-size-plan-modal__title">
                {title}
              </h3>
              {subtitle && (
                <p className="admin-size-plan-modal__subtitle">{subtitle}</p>
              )}
            </div>
            <button
              type="button"
              className="admin-size-plan-modal__close"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label="Закрыть"
            >
              <X size={18} strokeWidth={1.8} aria-hidden />
            </button>
          </header>
          {children}
        </div>
      </div>
    </ModalPortal>
  );
}
