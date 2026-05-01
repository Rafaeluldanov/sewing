/**
 * `OrderApplicationsCard` — блок «Нанесение» в карточке заказа.
 *
 * Этап «Нанесение на заказе покупателя» (см.
 * `apps/api/src/modules/order-applications/*`,
 * `packages/shared/src/order-applications.ts`).
 *
 * Серверный компонент: грузит список нанесений по заказу через
 * `getOrderApplications(orderId)`. Если backend упал — показывает
 * error-box, не валит карточку заказа (по тем же принципам, что
 * `WorkshopNeedsCard` / `CutReadinessCard`).
 *
 * UX по статусу заказа:
 *   - `DRAFT`        — рендерим интерактивную форму редактирования
 *     (`OrderApplicationsForm`). Менеджер может добавить/удалить
 *     строки и сохранить.
 *   - все остальные  — read-only список карточек нанесения.
 *
 * Backend / DTO / API не меняем — это чистая presentation-обёртка.
 */
import { Stamp } from 'lucide-react';
import type { OrderApplicationDto } from '@sewing/shared/order-applications';
import type { OrderStatus } from '@sewing/shared/orders';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { getOrderApplications } from '@/lib/order-applications-api';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { OrderApplicationsForm } from './order-applications-form';

interface Props {
  orderId: string;
  /**
   * Статус родительского заказа управляет режимом блока:
   *   - `DRAFT`         — форма редактирования (full-replace через PUT).
   *   - всё остальное   — read-only список (см. backend-инвариант
   *     `ORDER_APPLICATION_ORDER_LOCKED`).
   */
  orderStatus: OrderStatus;
}

function statusTone(status: string): AdminStatusTone {
  switch (status) {
    case 'PLANNED':
      return 'info';
    case 'SENT':
      return 'warning';
    case 'DONE':
      return 'success';
    case 'CANCELLED':
      return 'muted';
    default:
      return 'muted';
  }
}

export async function OrderApplicationsCard({ orderId, orderStatus }: Props) {
  let applications: OrderApplicationDto[] = [];
  let loadError: string | null = null;
  try {
    applications = await getOrderApplications(orderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить нанесения';
  }

  const isDraft = orderStatus === 'DRAFT';

  return (
    <div className="admin-order-item-card__section admin-order-applications">
      <div className="admin-order-item-card__subhead">
        <h3 className="admin-order-item-card__subtitle">
          <Stamp
            size={16}
            strokeWidth={1.7}
            aria-hidden
            style={{ verticalAlign: '-2px', marginRight: 6 }}
          />
          Нанесение
        </h3>
        {applications.length > 0 && (
          <span className="admin-order-item-card__meta">
            Строк: {applications.length}
          </span>
        )}
      </div>

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {isDraft ? (
        <OrderApplicationsForm
          orderId={orderId}
          initial={applications}
        />
      ) : (
        <ReadOnlyList applications={applications} />
      )}
    </div>
  );
}

function ReadOnlyList({
  applications,
}: {
  applications: OrderApplicationDto[];
}) {
  if (applications.length === 0) {
    return (
      <AdminEmptyState
        icon={<Stamp size={26} strokeWidth={1.6} aria-hidden />}
        title="Нанесений нет"
        hint="Менеджер не добавил нанесения, пока заказ был в черновике."
      />
    );
  }
  return (
    <ul className="admin-order-applications__list">
      {applications.map((app) => (
        <li key={app.id} className="admin-order-applications__item">
          <div className="admin-order-applications__item-head">
            <strong>{app.typeLabel}</strong>
            <AdminStatusBadge tone="muted">{app.stageLabel}</AdminStatusBadge>
            <AdminStatusBadge tone={statusTone(app.status)}>
              {app.statusLabel}
            </AdminStatusBadge>
          </div>
          <dl className="admin-deflist admin-deflist--compact">
            {app.placement && (
              <>
                <dt>Место</dt>
                <dd>{app.placement}</dd>
              </>
            )}
            {(app.widthMm != null || app.heightMm != null) && (
              <>
                <dt>Размер</dt>
                <dd>
                  {(app.widthMm ?? '—') + ' × ' + (app.heightMm ?? '—')} мм
                </dd>
              </>
            )}
            {app.colorsCount != null && (
              <>
                <dt>Цветов</dt>
                <dd>{app.colorsCount}</dd>
              </>
            )}
            {app.quantity != null && (
              <>
                <dt>Количество</dt>
                <dd>
                  {app.quantity} {app.unit}
                </dd>
              </>
            )}
            {app.colorText && (
              <>
                <dt>Цвет / описание</dt>
                <dd>{app.colorText}</dd>
              </>
            )}
            {app.description && (
              <>
                <dt>Описание</dt>
                <dd>{app.description}</dd>
              </>
            )}
            {app.comment && (
              <>
                <dt>Комментарий</dt>
                <dd>{app.comment}</dd>
              </>
            )}
            {app.fileUrl && (
              <>
                <dt>Файл макета</dt>
                <dd>
                  <a href={app.fileUrl} target="_blank" rel="noreferrer">
                    {app.fileUrl}
                  </a>
                </dd>
              </>
            )}
          </dl>
        </li>
      ))}
    </ul>
  );
}
