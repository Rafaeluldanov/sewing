'use client';

/**
 * `OrderAmendmentButton` — кнопка, открывающая `OrderAmendmentDialog`.
 * Обслуживает два входа фичи «Правка заказа» (`FEATURE_ORDER_AMENDMENTS`):
 *
 *   - «Изменить в производстве» — шапка карточки «Производство по
 *     размерам» на вкладке «Производство». Все три вкладки
 *     (Количество / Размерность / Маршрут), только `IN_PRODUCTION`.
 *   - «Изменить маршрут» — шапка карточки «Маршрут операций» там же.
 *     Одна вкладка «Маршрут», окно `ORDER_ROUTE_EDITABLE_STATUSES`
 *     (всё, кроме `DONE`/`CANCELLED`): состав операций меняют и на
 *     расчёте, и на ходу в цеху.
 *
 * Различие несёт не кнопка, а набор переданных состояний: `null` в
 * `quantityState`/`sizeState` убирает соответствующие вкладки. Право
 * управлять заказом и статус проверяет вызывающая сторона
 * (`OrderProductionTab`), тут только UI.
 */
import { useState } from 'react';
import { SlidersHorizontal, Workflow } from 'lucide-react';
import type {
  OperationAmendmentStateDto,
  QuantityAmendmentStateDto,
  SizeAmendmentStateDto,
} from '@sewing/shared';
import { OrderAmendmentDialog } from './order-amendment-dialog';
import type { RatesAmendmentState } from './rates-amendment-tab';

interface Props {
  orderId: string;
  /** `null` — вкладки нет (вход «Изменить маршрут»). */
  quantityState: QuantityAmendmentStateDto | null;
  sizeState: SizeAmendmentStateDto | null;
  operationState: OperationAmendmentStateDto;
  /** `null` — вкладки «Расценки» нет (нет прав / финальный статус / пустой маршрут). */
  ratesState: RatesAmendmentState | null;
  /** Подпись кнопки; она же — заголовок окна. */
  label: string;
  /** Иконка: слайдеры у полной правки, схема маршрута у route-only. */
  variant?: 'full' | 'route';
  testId?: string;
}

export function OrderAmendmentButton({
  orderId,
  quantityState,
  sizeState,
  operationState,
  ratesState,
  label,
  variant = 'full',
  testId = 'order-amendment-button',
}: Props) {
  const [open, setOpen] = useState(false);
  const Icon = variant === 'route' ? Workflow : SlidersHorizontal;

  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        <Icon size={16} strokeWidth={1.6} aria-hidden />
        {label}
      </button>
      {open && (
        <OrderAmendmentDialog
          orderId={orderId}
          quantityState={quantityState}
          sizeState={sizeState}
          operationState={operationState}
          ratesState={ratesState}
          title={label}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
