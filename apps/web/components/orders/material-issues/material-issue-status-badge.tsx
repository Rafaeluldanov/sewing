/**
 * `MaterialIssueStatusBadge` — человекочитаемый бейдж статуса
 * документа «Фактический расход материалов» (см.
 * `@sewing/shared/material-issues::MATERIAL_ISSUE_STATUSES`).
 *
 * Используем уже существующий `AdminStatusBadge` из admin-UI-kit-а,
 * чтобы не заводить новую палитру цветов. Тон подбирается по статусу:
 *
 *   - DRAFT     → muted   (серый — «черновик», нейтральный);
 *   - POSTED    → success (зелёный — «проведён»);
 *   - CANCELLED → danger  (красный — «отменён»).
 *
 * Это зеркалирует `getOrderStatusTone` для заказа (DRAFT → muted /
 * CANCELLED → danger / …) и оттенки `statusTone` для общих статусов.
 * Лейблы берём из shared-словаря `MATERIAL_ISSUE_STATUS_LABELS`.
 */
import {
  MATERIAL_ISSUE_STATUS_LABELS,
  type MaterialIssueStatus,
} from '@sewing/shared/material-issues';
import { AdminStatusBadge } from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';

interface Props {
  status: MaterialIssueStatus | string;
}

function toneForStatus(status: string): AdminStatusTone {
  switch (status as MaterialIssueStatus) {
    case 'DRAFT':
      return 'muted';
    case 'POSTED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function labelForStatus(status: string): string {
  const known = MATERIAL_ISSUE_STATUS_LABELS[status as MaterialIssueStatus];
  return known ?? status;
}

export function MaterialIssueStatusBadge({ status }: Props) {
  return (
    <AdminStatusBadge tone={toneForStatus(status)}>
      {labelForStatus(status)}
    </AdminStatusBadge>
  );
}
