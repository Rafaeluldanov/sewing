/**
 * Badge статуса `OrderSample` — используется в карточке `/admin/orders/[id]`
 * на вкладке «Сигнальный образец» и в строках списка.
 *
 * Цветовая палитра без новых классов — использует уже существующие
 * `AdminStatusBadge`-токены через простой `tone`.
 */

import type { OrderSampleStatus } from '@sewing/shared/order-samples';
import { AdminStatusBadge } from '@/components/admin';

const LABELS: Record<OrderSampleStatus, string> = {
  IN_PROGRESS: 'В работе',
  READY_FOR_APPROVAL: 'На согласовании',
  APPROVED: 'Согласован',
  REJECTED: 'Отклонён',
  CANCELLED: 'Отменён',
};

import type { AdminStatusTone } from '@/lib/admin-labels';

const TONES: Record<OrderSampleStatus, AdminStatusTone> = {
  IN_PROGRESS: 'info',
  READY_FOR_APPROVAL: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'muted',
};

export function OrderSampleStatusBadge({
  status,
}: {
  status: OrderSampleStatus;
}): React.ReactElement {
  return <AdminStatusBadge tone={TONES[status]}>{LABELS[status]}</AdminStatusBadge>;
}
