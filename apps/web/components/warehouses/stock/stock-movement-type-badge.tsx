/**
 * `StockMovementTypeBadge` — лейбл типа движения в человекочитаемой
 * форме. Используется в таблице «Движения» раздела `/admin/warehouses`
 * для строк и материалов (`STOCK_MOVEMENT_TYPE` в
 * `apps/api/src/modules/stock/stock.constants.ts`), и готовой
 * продукции (`FINISHED_GOODS_MOVEMENT_TYPE` в
 * `apps/api/src/modules/finished-goods/finished-goods.constants.ts`):
 *
 *   PURCHASE_RECEIPT   → «Приёмка»            (info, материалы)
 *   MATERIAL_ISSUE     → «Расход материалов»  (warning, материалы)
 *   PRODUCTION_RECEIPT → «Выпуск»             (info, готовая продукция)
 *   SHIPMENT           → «Отгрузка»           (warning, готовая продукция)
 *   REVERSAL           → «Сторно»             (muted, общий)
 *   ADJUSTMENT         → «Корректировка»      (warning, общий)
 *   TRANSFER           → «Перемещение»        (info, общий)
 */
import { AdminStatusBadge } from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';

interface Props {
  type: string;
}

const TYPE_LABELS: Record<string, { label: string; tone: AdminStatusTone }> = {
  PURCHASE_RECEIPT: { label: 'Приёмка', tone: 'info' },
  MATERIAL_ISSUE: { label: 'Расход материалов', tone: 'warning' },
  PRODUCTION_RECEIPT: { label: 'Выпуск', tone: 'info' },
  SHIPMENT: { label: 'Отгрузка', tone: 'warning' },
  REVERSAL: { label: 'Сторно', tone: 'muted' },
  ADJUSTMENT: { label: 'Корректировка', tone: 'warning' },
  TRANSFER: { label: 'Перемещение', tone: 'info' },
};

export function StockMovementTypeBadge({ type }: Props) {
  const known = TYPE_LABELS[type];
  if (known) {
    return <AdminStatusBadge tone={known.tone}>{known.label}</AdminStatusBadge>;
  }
  return <AdminStatusBadge tone="muted">{type}</AdminStatusBadge>;
}
