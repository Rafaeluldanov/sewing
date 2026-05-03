/**
 * `StockDirectionBadge` — мягкая «пилюля» направления движения
 * (`IN | OUT`) для журнала `StockMovement` (вкладка «Движения»
 * в `/admin/warehouses?tab=movements`).
 *
 * IN  → «Приход» (info-тон).
 * OUT → «Расход» (danger-тон — визуально отличает изъятие
 * остатка). Тон берём из существующего словаря `AdminStatusBadge`,
 * не вводя новых цветов (см. ТЗ §6 «не добавлять новую цветовую
 * систему»).
 */
import { AdminStatusBadge } from '@/components/admin';

interface Props {
  direction: 'IN' | 'OUT' | string;
}

export function StockDirectionBadge({ direction }: Props) {
  if (direction === 'IN') {
    return <AdminStatusBadge tone="info">Приход</AdminStatusBadge>;
  }
  if (direction === 'OUT') {
    return <AdminStatusBadge tone="danger">Расход</AdminStatusBadge>;
  }
  return <AdminStatusBadge tone="muted">{direction}</AdminStatusBadge>;
}
