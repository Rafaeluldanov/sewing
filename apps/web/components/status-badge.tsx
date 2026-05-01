import type { OrderStatus } from '@sewing/shared/orders';
import { ORDER_STATUS_LABELS } from '@/lib/orders-api';

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`status-badge ${status.toLowerCase()}`}>
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}
