'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * ModalPortal — общая обёртка для всех overlay-модалок проекта.
 *
 * Рендерит children как прямого потомка `<body>` через `createPortal`.
 * Это гарантирует, что `position: fixed` overlay'ев позиционируется
 * относительно viewport, а не ближайшего ancestor'а с
 * `transform`/`filter`/`will-change`/`contain`/`perspective` (в этом
 * проекте такая ловушка уже один раз ломала bulk-print modal —
 * `.admin-page-shell` имел `animation: ... both` с `transform: translateY(0)`
 * в финальном кадре, что делало page-shell containing-block-ом для
 * всех `position: fixed` потомков).
 *
 * SSR-guard через `mounted` state: на сервере `document` нет, поэтому
 * первый рендер возвращает `null`, второй (в `useEffect` после mount)
 * — собственно portal.
 *
 * Использование:
 *   <ModalPortal>
 *     <div className="qr-modal" role="dialog" aria-modal="true" ...>
 *       ...
 *     </div>
 *   </ModalPortal>
 *
 * Не делает focus-trap, body-scroll lock, ESC-handling — это
 * ответственность вызывающего компонента (см. примеры в bulk-print-panel,
 * passport-confirm-modal). ModalPortal делает ровно одно: гарантирует,
 * что overlay рендерится в `document.body`.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
