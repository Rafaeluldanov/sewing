/**
 * Превью эффекта сигнального образца на тираж — таблица «Материалы /
 * Включить в тираж / Сейчас / После согласования».
 *
 * Принимает текущий стейт формы запуска образца (`materialMode`,
 * `countsTowardOrderQty`, `qty`, `orderSizeQtyPlan`) и рендерит две
 * человекочитаемые строки. Никакого fetch — pure-функциональный
 * компонент.
 */

import type { OrderSampleMaterialMode } from '@sewing/shared/order-samples';

export interface OrderSampleEffectPreviewProps {
  materialMode: OrderSampleMaterialMode;
  countsTowardOrderQty: boolean;
  qty: number;
  orderSizeQtyPlan: number;
  sizeCode: string;
}

function materialModeLabel(mode: OrderSampleMaterialMode): string {
  return mode === 'SAMPLE_ONLY'
    ? 'Только на образец (preview)'
    : 'На весь заказ (через "Потребности цеха")';
}

function countsLabel(value: boolean): string {
  return value ? 'Да' : 'Нет';
}

export function OrderSampleEffectPreview({
  materialMode,
  countsTowardOrderQty,
  qty,
  orderSizeQtyPlan,
  sizeCode,
}: OrderSampleEffectPreviewProps): React.ReactElement {
  const remaining = countsTowardOrderQty
    ? Math.max(orderSizeQtyPlan - qty, 0)
    : orderSizeQtyPlan;
  const after = countsTowardOrderQty
    ? `К тиражу остаётся ${remaining} шт. по размеру ${sizeCode}`
    : `К тиражу остаётся ${orderSizeQtyPlan} шт.; образец ${qty} шт. — сверху`;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
      <thead>
        <tr>
          <th align="left">Материалы</th>
          <th align="left">Включить в тираж</th>
          <th align="left">Сейчас</th>
          <th align="left">После согласования</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{materialModeLabel(materialMode)}</td>
          <td>{countsLabel(countsTowardOrderQty)}</td>
          <td>
            {orderSizeQtyPlan} шт. по {sizeCode}
            {materialMode === 'SAMPLE_ONLY'
              ? ` · считаем на ${qty} шт. (preview)`
              : ' · потребность на весь заказ'}
          </td>
          <td>{after}</td>
        </tr>
      </tbody>
    </table>
  );
}
