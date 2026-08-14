'use client';

/**
 * Карточка «В работе у вас» — паспорта, которые числятся за
 * сотрудником (`Passport.currentEmployeeId = me`, `IN_PROGRESS`) и ещё
 * не закрыты.
 *
 * Зачем общий компонент: рабочая карточка в scan-терминалах (`/qc`,
 * `/wto`, plain-режим `/packing`) живёт в client-state, поэтому после
 * F5, возврата в кабинет или перезапуска приложения экран показывал
 * чистую кнопку «Сканировать паспорт», а паспорт всё это время висел
 * на человеке. Всплывает это на смене операции: backend не даёт
 * переключиться, пока есть незакрытые паспорта
 * (`SHIFT_HAS_ACTIVE_PASSPORTS`, см. `ShiftsService.switchOperation`),
 * а найти их в кабинете было негде.
 *
 * Источник данных везде один — `GET /shifts/current-work`, ровно тот
 * набор, который проверяет `switchOperation`. То есть показываем
 * именно то, что блокирует переключение.
 *
 * `onOpen` опционален: где есть куда открыть карточку — строки
 * кликабельны, где нет (коробочный режим упаковки) — карточка
 * информационная.
 */

import type { CurrentWorkPassportDto } from '@sewing/shared/shifts';
import { Icon } from '@/components/icon';

interface Props {
  items: CurrentWorkPassportDto[];
  /** Подсказка под заголовком — у каждого кабинета своя. */
  hint: string;
  /**
   * Открыть паспорт по тапу. ВАЖНО: обработчик обязан открывать
   * карточку read-only запросом (`GET .../passports/:id`), а не
   * скан-сценарием — повторный `POST /api/passports/:id/scan`
   * переставил бы паспорт на операцию ТЕКУЩЕЙ смены.
   */
  onOpen?: (passportId: string) => void;
  pending?: boolean;
}

export function PassportsInWorkCard({ items, hint, onOpen, pending }: Props) {
  if (items.length === 0) return null;
  const title =
    items.length === 1 ? 'В работе у вас' : `В работе у вас (${items.length})`;
  return (
    <div
      className="scan-card scan-card--simple"
      aria-label="Паспорта в работе у вас"
    >
      <h2 className="scan-card__title">
        <Icon name="work" size={22} />
        <span style={{ marginLeft: '0.45rem' }}>{title}</span>
      </h2>
      <p className="scan-card__hint">{hint}</p>
      <ul className="operation-switcher__list">
        {items.map((p) => {
          const label = (
            <>
              <span className="operation-switcher__option-name">
                {p.number} · {p.productName}, {p.color}, {p.sizeCode} ·{' '}
                {p.qtyGood} шт.
              </span>
              <span className="operation-switcher__option-code">
                {p.currentOperationName ?? 'без операции'}
              </span>
            </>
          );
          return (
            <li key={p.id}>
              {onOpen ? (
                <button
                  type="button"
                  className="operation-switcher__option"
                  onClick={() => onOpen(p.id)}
                  disabled={pending}
                >
                  {label}
                </button>
              ) : (
                <div className="operation-switcher__option">{label}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
