'use client';

import { useTransition, useState } from 'react';
import type {
  OrderOutsourceDisplayStatus,
  OutsourceTriggerType,
} from '@sewing/shared/orders';
import {
  markOutsourceRequirementOrderedAction,
  markOutsourceRequirementReceivedAction,
} from '../actions';

/**
 * MVP-3 техкарт (ADR-0022 §«Manual execution status»): минимальные
 * action-кнопки под строкой блока «Внешние потребности» на карточке
 * заказа.
 *
 * Сознательно нет `<select>`, нет inline-edit формы, нет dropdown-ов —
 * только одна-две простых кнопки в зависимости от композитного
 * `displayStatus`. Доступ ограничен на уровне страницы (показываем
 * только для `SHOP_MANAGER` / `ADMIN`); компонент сам RBAC не
 * проверяет.
 *
 * Подтверждение через `window.confirm` — переход операционно значимый
 * (отметка «отдали подрядчику» / «получили обратно») и без подтверждения
 * легко поставить случайно.
 */
interface Props {
  orderId: string;
  requirementId: string;
  displayStatus: OrderOutsourceDisplayStatus;
  triggerType: OutsourceTriggerType;
  isReadyToOrder: boolean;
}

export function OutsourceStatusActions({
  orderId,
  requirementId,
  displayStatus,
  triggerType,
  isReadyToOrder,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>, confirmMsg: string) => () => {
    if (!window.confirm(confirmMsg)) return;
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось обновить статус',
        );
      }
    });
  };

  // Кнопка «Отметить как заказано» доступна:
  //   - PLANNED + MANUAL → всегда;
  //   - PLANNED + CUT_READY → только когда крой реально готов
  //     (`isReadyToOrder = true`);
  //   - READY_TO_ORDER (это всегда CUT_READY + готов) → всегда.
  const showMarkOrdered =
    (displayStatus === 'PLANNED' &&
      (triggerType === 'MANUAL' || isReadyToOrder)) ||
    displayStatus === 'READY_TO_ORDER';

  const showMarkReceived = displayStatus === 'ORDERED';

  if (!showMarkOrdered && !showMarkReceived) return null;

  return (
    <div style={{ marginTop: '0.35rem' }}>
      {error && (
        <div className="error-box" style={{ marginBottom: '0.4rem' }}>
          {error}
        </div>
      )}
      <div className="actions-row" style={{ margin: 0, gap: '0.4rem' }}>
        {showMarkOrdered && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={run(
              () =>
                markOutsourceRequirementOrderedAction(orderId, requirementId),
              'Отметить как заказано? Действие фиксирует, что подряд отдан подрядчику.',
            )}
          >
            {pending ? 'Сохраняем…' : 'Отметить как заказано'}
          </button>
        )}
        {showMarkReceived && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={run(
              () =>
                markOutsourceRequirementReceivedAction(orderId, requirementId),
              'Отметить как получено? Действие фиксирует, что результат подряда уже у нас.',
            )}
          >
            {pending ? 'Сохраняем…' : 'Отметить как получено'}
          </button>
        )}
      </div>
    </div>
  );
}
