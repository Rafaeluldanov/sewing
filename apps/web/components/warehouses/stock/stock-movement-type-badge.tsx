/**
 * `StockMovementTypeBadge` — лейбл типа движения склада в
 * человекочитаемой форме (см. `STOCK_MOVEMENT_TYPE` в
 * `apps/api/src/modules/stock/stock.constants.ts`):
 *
 *   PURCHASE_RECEIPT → «Приёмка»     (info)
 *   MATERIAL_ISSUE   → «Расход материалов» (warning — это всегда OUT)
 *   REVERSAL         → «Сторно»      (muted — служебная коррекция)
 *   ADJUSTMENT       → «Корректировка» (warning — ручная правка)
 *
 * Никаких mutation-кнопок (например, «Сторно» / «Корректировка»)
 * рядом с бейджем не рисуем — UI на этой итерации read-only.
 * Backend ADJUSTMENT-тип формально присутствует в enum, но на MVP
 * никем не записывается; держим лейбл, чтобы при появлении
 * adjustment-документа в будущем UI не падал на «unknown type».
 */
import { AdminStatusBadge } from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';

interface Props {
  type: string;
}

const TYPE_LABELS: Record<string, { label: string; tone: AdminStatusTone }> = {
  PURCHASE_RECEIPT: { label: 'Приёмка', tone: 'info' },
  MATERIAL_ISSUE: { label: 'Расход материалов', tone: 'warning' },
  REVERSAL: { label: 'Сторно', tone: 'muted' },
  ADJUSTMENT: { label: 'Корректировка', tone: 'warning' },
};

export function StockMovementTypeBadge({ type }: Props) {
  const known = TYPE_LABELS[type];
  if (known) {
    return <AdminStatusBadge tone={known.tone}>{known.label}</AdminStatusBadge>;
  }
  return <AdminStatusBadge tone="muted">{type}</AdminStatusBadge>;
}
