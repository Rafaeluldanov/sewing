'use client';

/**
 * Inline-форма «Запуск сигнального образца» — стиль
 * `CreateFinishedGoodsShipmentDialog`: открывается по клику кнопки,
 * рендерится прямо в карточке (без модалок-абстракций, которых в
 * проекте нет).
 *
 * Поля:
 *   - product (если у заказа > 1 productId — селект; иначе скрыто);
 *   - size (select из размеров заказа);
 *   - qty (int, default 1, min 1);
 *   - routeTemplateId (опциональный select);
 *   - materialMode (radio: SAMPLE_ONLY / FULL_ORDER);
 *   - countsTowardOrderQty (switch-checkbox; default `false`);
 *   - comment;
 *   - preview-блок «Материалы / Включить в тираж / Сейчас /
 *     После согласования» (см. `OrderSampleEffectPreview`).
 *
 * Сабмит через `<form action={startOrderSampleAction.bind(null, orderId)}>`,
 * `useFormState` для error/success.
 */

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type {
  OrderSampleMaterialMode,
} from '@sewing/shared/order-samples';
import { startOrderSampleAction } from '@/app/admin/orders/[id]/order-samples-actions';
import { initialOrderSampleFormState } from '@/lib/order-samples-domain';
import { OrderSampleEffectPreview } from './order-sample-effect-preview';

export interface StartOrderSampleSizeOption {
  sizeId: string;
  sizeCode: string;
  qtyPlan: number;
}

export interface StartOrderSampleRouteOption {
  id: string;
  code: string;
  name: string;
}

export interface StartOrderSampleModalProps {
  orderId: string;
  sizes: StartOrderSampleSizeOption[];
  routeTemplates: StartOrderSampleRouteOption[];
  onClose: () => void;
}

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      {pending ? 'Запуск...' : 'Запустить образец'}
    </button>
  );
}

export function StartOrderSampleModal({
  orderId,
  sizes,
  routeTemplates,
  onClose,
}: StartOrderSampleModalProps): React.ReactElement {
  const initialSize = sizes[0];
  const [sizeId, setSizeId] = useState(initialSize?.sizeId ?? '');
  const [qty, setQty] = useState(1);
  const [materialMode, setMaterialMode] =
    useState<OrderSampleMaterialMode>('SAMPLE_ONLY');
  const [countsTowardOrderQty, setCountsTowardOrderQty] = useState(false);
  const [state, formAction] = useFormState(
    startOrderSampleAction.bind(null, orderId),
    initialOrderSampleFormState,
  );

  const currentSize = sizes.find((s) => s.sizeId === sizeId);
  const orderSizeQtyPlan = currentSize?.qtyPlan ?? 0;
  const sizeCode = currentSize?.sizeCode ?? '—';

  return (
    <form action={formAction} className="admin-card" style={{ padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Запуск сигнального образца</h3>
        <button
          type="button"
          onClick={onClose}
          className="admin-btn admin-btn--ghost"
          aria-label="Закрыть"
        >
          ×
        </button>
      </header>

      <div style={{ marginTop: 12 }}>
        <label htmlFor="sizeId">Размер из заказа</label>
        <select
          id="sizeId"
          name="sizeId"
          value={sizeId}
          onChange={(e) => setSizeId(e.target.value)}
          required
        >
          {sizes.map((s) => (
            <option key={s.sizeId} value={s.sizeId}>
              {s.sizeCode} (план: {s.qtyPlan} шт.)
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor="qty">Количество образцов</label>
        <input
          id="qty"
          name="qty"
          type="number"
          min={1}
          step={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
          required
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor="routeTemplateId">Маршрут образца (опционально)</label>
        <select id="routeTemplateId" name="routeTemplateId" defaultValue="">
          <option value="">— Использовать маршрут заказа —</option>
          {routeTemplates.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.name}
            </option>
          ))}
        </select>
      </div>

      <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: 8 }}>
        <legend>Стратегия материалов</legend>
        <label style={{ display: 'block' }}>
          <input
            type="radio"
            name="materialMode"
            value="SAMPLE_ONLY"
            checked={materialMode === 'SAMPLE_ONLY'}
            onChange={() => setMaterialMode('SAMPLE_ONLY')}
          />{' '}
          Только на образец
        </label>
        <p style={{ marginLeft: 24, marginBottom: 8, color: '#666' }}>
          Система запустит образец и рассчитает потребность только на выбранное
          количество. Потребность на тираж формируется после согласования.
        </p>
        <label style={{ display: 'block' }}>
          <input
            type="radio"
            name="materialMode"
            value="FULL_ORDER"
            checked={materialMode === 'FULL_ORDER'}
            onChange={() => setMaterialMode('FULL_ORDER')}
          />{' '}
          На весь заказ
        </label>
        <p style={{ marginLeft: 24, marginBottom: 0, color: '#666' }}>
          Система запустит образец, а потребность на материалы может быть
          сформирована на весь заказ.
        </p>
      </fieldset>

      <div
        style={{
          marginTop: 12,
          padding: 8,
          border: '1px solid #ddd',
          borderRadius: 4,
        }}
      >
        <label
          htmlFor="countsTowardOrderQty"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <input
            id="countsTowardOrderQty"
            name="countsTowardOrderQty"
            type="checkbox"
            role="switch"
            checked={countsTowardOrderQty}
            onChange={(e) => setCountsTowardOrderQty(e.target.checked)}
          />
          <span>Включить образец в тираж</span>
        </label>
        <p style={{ marginTop: 4, marginBottom: 0, color: '#666' }}>
          {countsTowardOrderQty
            ? 'После согласования образец будет засчитан в количество заказа по выбранному размеру.'
            : 'Образец будет отдельной единицей сверх тиража. Количество заказа не уменьшится.'}
        </p>
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor="comment">Комментарий (опционально)</label>
        <textarea id="comment" name="comment" rows={2} maxLength={1000} />
      </div>

      <OrderSampleEffectPreview
        materialMode={materialMode}
        countsTowardOrderQty={countsTowardOrderQty}
        qty={qty}
        orderSizeQtyPlan={orderSizeQtyPlan}
        sizeCode={sizeCode}
      />

      {state.error ? (
        <p role="alert" style={{ color: 'crimson', marginTop: 12 }}>
          {state.error}
        </p>
      ) : null}
      {state.successMessage ? (
        <p role="status" style={{ color: 'darkgreen', marginTop: 12 }}>
          {state.successMessage}
        </p>
      ) : null}

      <footer style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <SubmitButton />
        <button type="button" onClick={onClose} className="admin-btn">
          Отмена
        </button>
      </footer>
    </form>
  );
}
