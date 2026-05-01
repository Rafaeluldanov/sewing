/**
 * `OrderOutsourceList` — управленческий блок «Внешние подряды» для
 * вкладки «Потребности» карточки заказа.
 *
 * Это presentation-only компонент: данные приходят готовыми из
 * snapshot заказа (`OrderDetailDto.outsourceRequirements`) — никакого
 * дополнительного fetch / агрегации мы не делаем. Семантика и порядок
 * полей совпадают с уже существующим `OutsourceSnapshotCard` в
 * legacy `/orders/[id]` (см. `apps/web/app/orders/[id]/page.tsx`),
 * но рендерится через admin-UI (`AdminCard` + admin-deflist), а не
 * через legacy `card`-стили — это и единственная причина, по которой
 * блок переехал в admin-UI: чтобы две карточки заказа не показывали
 * один и тот же snapshot в разных стилях.
 *
 * MVP-3 техкарт (ADR-0022 §«Manual execution status»): action-кнопки
 * «Отметить как заказано / Отметить как получено» рендерятся через
 * существующий `OutsourceStatusActions` (легаси-компонент в
 * `apps/web/app/orders/[id]/outsource-status-actions.tsx`) — никаких
 * новых server-actions / endpoint-ов мы не вводим, рендер просто
 * включает уже работающий клиентский компонент.
 */
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import type { OrderOutsourceRequirementDto } from '@sewing/shared/orders';
import { Truck } from 'lucide-react';
import { OutsourceStatusActions } from '@/app/orders/[id]/outsource-status-actions';

interface Props {
  orderId: string;
  items: OrderOutsourceRequirementDto[];
  /** `true` для ADMIN/SHOP_MANAGER — рендерим action-кнопки. */
  canManage: boolean;
}

function statusTone(displayStatus: OrderOutsourceRequirementDto['displayStatus']) {
  if (displayStatus === 'RECEIVED') return 'success' as const;
  if (displayStatus === 'READY_TO_ORDER') return 'success' as const;
  if (displayStatus === 'ORDERED') return 'warning' as const;
  return 'muted' as const;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return '—';
  }
}

export function OrderOutsourceList({ orderId, items, canManage }: Props) {
  const hasCutReadyAwaiting = items.some(
    (o) => o.triggerType === 'CUT_READY' && !o.isReadyToOrder,
  );

  return (
    <AdminCard className="admin-order-detail-card-compact">
      <AdminSectionHeader
        icon={<Truck size={18} strokeWidth={1.7} aria-hidden />}
        title="Внешние подряды"
        hint={items.length > 0 ? `${items.length} строк` : undefined}
      />

      {items.length === 0 ? (
        <AdminEmptyState
          icon={<Truck size={26} strokeWidth={1.6} aria-hidden />}
          title="Внешние подряды не зафиксированы"
          hint="Snapshot техкарты пуст или техкарта не выбрана."
        />
      ) : (
        <>
          {hasCutReadyAwaiting && (
            <p
              className="admin-muted"
              style={{ fontSize: '0.85rem', marginBottom: 8 }}
            >
              Часть подрядов станет доступна после размещения кроя в ячейки.
            </p>
          )}
          <ul className="order-outsource-list">
            {items.map((o) => {
              const tone = statusTone(o.displayStatus);
              const showQty = o.totalQty != null && o.unit != null;
              const showNorm = o.qtyPerUnit != null && o.unit != null;
              return (
                <li key={o.id} className="order-outsource-list__item">
                  <div className="order-outsource-list__head">
                    <strong className="order-outsource-list__name">
                      {o.name}
                    </strong>
                    {o.displayStatusLabel && (
                      <AdminStatusBadge tone={tone}>
                        {o.displayStatusLabel}
                      </AdminStatusBadge>
                    )}
                  </div>
                  <dl className="admin-deflist admin-deflist--compact">
                    {showQty && (
                      <>
                        <dt>Объём</dt>
                        <dd>
                          {o.totalQty} {o.unit}
                        </dd>
                      </>
                    )}
                    {showNorm && (
                      <>
                        <dt>Норма</dt>
                        <dd>
                          {o.qtyPerUnit} {o.unit} / 1 шт
                        </dd>
                      </>
                    )}
                    {o.vendorName && (
                      <>
                        <dt>Подрядчик</dt>
                        <dd>{o.vendorName}</dd>
                      </>
                    )}
                    {o.note && (
                      <>
                        <dt>Заметка</dt>
                        <dd>{o.note}</dd>
                      </>
                    )}
                    {o.orderedAt && (
                      <>
                        <dt>Отдано подрядчику</dt>
                        <dd>{formatDateTime(o.orderedAt)}</dd>
                      </>
                    )}
                    {o.receivedAt && (
                      <>
                        <dt>Получено</dt>
                        <dd>{formatDateTime(o.receivedAt)}</dd>
                      </>
                    )}
                  </dl>
                  {canManage && (
                    <OutsourceStatusActions
                      orderId={orderId}
                      requirementId={o.id}
                      displayStatus={o.displayStatus}
                      triggerType={o.triggerType}
                      isReadyToOrder={o.isReadyToOrder}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </AdminCard>
  );
}
