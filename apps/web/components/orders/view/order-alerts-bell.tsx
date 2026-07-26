'use client';

/**
 * `OrderAlertsBell` — колокольчик уведомлений в шапке заказа
 * `/admin/orders/[id]`.
 *
 * Раньше алерты заказа жили отдельным блоком `OrderActionCenter` во всю
 * ширину окна над линейкой вкладок и дублировались жёлтой плашкой
 * «План операций устарел» внутри шапки. Оба занимали первый экран, хотя
 * в штатном заказе читаются один раз. Теперь тот же список свёрнут в
 * кнопку-колокольчик сразу после бейджа статуса: цифра = число открытых
 * задач, цвет цифры = самый тяжёлый `tone` в списке.
 *
 * Компонент — только оболочка (открыть/закрыть + a11y). Сам список
 * алертов приходит `children` уже отрендеренным на сервере
 * (`buildAlerts` + `OrderAlertsList` в `order-action-center.tsx`), чтобы
 * логика алертов осталась в одном месте и не уезжала в клиентский
 * бандл.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { AlertTone } from './order-action-center';

interface Props {
  /** Число открытых задач по заказу (`buildAlerts(...).length`). */
  count: number;
  /** Самый тяжёлый тон в списке; `null` — задач нет. */
  tone: AlertTone | null;
  /** Сколько из них критичных — нужно только для screen-reader-подписи. */
  dangerCount?: number;
  /** Готовая «начинка» поповера (шапка + список либо empty-state). */
  children: React.ReactNode;
}

export function OrderAlertsBell({
  count,
  tone,
  dangerCount = 0,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  // Слушатели живём только пока поповер открыт: закрытие по Esc и по
  // клику вне колокольчика.
  useEffect(() => {
    if (!open) return;

    const closeAndRefocus = () => {
      setOpen(false);
      buttonRef.current?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndRefocus();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  const isEmpty = count === 0;
  // Больше 9 в кружок не влезает — счётчик обрезаем, полный список
  // всё равно в поповере.
  const badgeText = count > 9 ? '9+' : String(count);

  return (
    <div className="order-alerts-bell" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`order-alerts-bell__button${
          isEmpty ? ' order-alerts-bell__button--empty' : ''
        }`}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={buildBellLabel(count, dangerCount)}
        title={buildBellLabel(count, dangerCount)}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Bell size={18} strokeWidth={1.7} aria-hidden />
        {!isEmpty && (
          <span
            className={`order-alerts-bell__count order-alerts-bell__count--${
              tone ?? 'info'
            }`}
            aria-hidden
          >
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div
          className="order-alerts-popover"
          id={popoverId}
          role="dialog"
          aria-label="Уведомления по заказу"
          // Переход по ссылке алерта меняет вкладку под шапкой —
          // поповер при этом закрываем, иначе он висит над новой
          // вкладкой.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Подпись для screen-reader: цифра в кружке сама по себе ничего не
 * говорит, поэтому расшифровываем и число, и наличие критичных.
 */
function buildBellLabel(count: number, dangerCount: number): string {
  if (count === 0) return 'Уведомления по заказу: нет открытых задач';
  const base = `Уведомления по заказу: ${count}`;
  if (dangerCount === 0) return base;
  const word =
    dangerCount % 10 === 1 && dangerCount % 100 !== 11
      ? 'критическое'
      : 'критических';
  return `${base}, из них ${dangerCount} ${word}`;
}
