/**
 * Блок «Себестоимость и продажа» в карточке заказа `/admin/orders/[id]`.
 *
 * Этап «Себестоимость заказа» (см.
 * `prisma/schema.prisma::OrderCostEstimate`,
 * `apps/api/src/modules/orders/orders.service.ts::completeCalculation`,
 * `packages/shared/src/order-cost-estimates.ts`).
 *
 * Этап «Цена продажи за единицу» (см. ТЗ §C, `model
 * Order.customerUnitPrice`): сюда же добавлен read-only блок
 * с ценой продажи / выручкой / маржой. Менять цену можно из
 * `/admin/orders/[id]/edit`.
 *
 * Серверный компонент (server-only render): получает уже подгруженный
 * `OrderDetailDto` и рендерит сводку:
 *   - себестоимость: итог в рублях / дата фиксации / номер версии расчёта;
 *   - breakdown по типам строк (Материалы / Фурнитура / Нанесение /
 *     Прочее);
 *   - продажа: цена продажи за единицу (RUB/USD) / количество /
 *     выручка / себестоимость / маржа (только в RUB; для USD-цены
 *     маржа намеренно не считается без курса — exchange-rate API
 *     out of scope, см. ТЗ §E «Не делать»).
 *
 * Если активного расчёта нет (`currentCostEstimate == null`),
 * рисуем подсказку, что себестоимость зафиксируется после
 * нажатия «Завершить расчёт».
 *
 * Логика статусов: компонент сам решает, что показать, по
 * `order.status` — кнопок управления здесь нет, они живут в
 * `OrderWorkflowCard` (см. `/admin/orders/[id]/page.tsx`).
 */
import { Receipt } from 'lucide-react';
import {
  ORDER_COST_ESTIMATE_LINE_KIND_LABELS,
  type OrderCostEstimateDto,
  type OrderCostEstimateLineKind,
} from '@sewing/shared/order-cost-estimates';
import type { OrderDetailDto } from '@sewing/shared/orders';
import {
  AdminCard,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';

function formatRub(raw: string | number | null | undefined): string {
  if (raw == null) return '—';
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(num);
}

function formatUsd(raw: string | number | null | undefined): string {
  if (raw == null) return '—';
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(num);
}

function formatMoney(
  raw: string | number | null | undefined,
  currency: 'RUB' | 'USD' | null | undefined,
): string {
  if ((currency ?? 'RUB') === 'USD') return formatUsd(raw);
  return formatRub(raw);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function bucketLines(estimate: OrderCostEstimateDto) {
  const buckets: Record<OrderCostEstimateLineKind, number> = {
    MATERIAL: 0,
    HARDWARE: 0,
    APPLICATION: 0,
    OTHER: 0,
  };
  for (const l of estimate.lines) {
    const k = (l.kind as OrderCostEstimateLineKind) ?? 'OTHER';
    if (k in buckets) {
      buckets[k] += Number(l.lineTotalRub) || 0;
    } else {
      buckets.OTHER += Number(l.lineTotalRub) || 0;
    }
  }
  return buckets;
}

export function OrderCostEstimateCard({ order }: { order: OrderDetailDto }) {
  const estimate = order.currentCostEstimate ?? null;
  const totalRub =
    order.costEstimateTotalRub ?? estimate?.totalCostRub ?? null;
  const completedAt =
    order.costEstimateCompletedAt ?? estimate?.completedAt ?? null;
  const version = order.costEstimateVersion ?? estimate?.version ?? null;

  const isLocked = order.status === 'IN_PRODUCTION' || order.status === 'DONE';
  const hasEstimate = totalRub != null;

  return (
    <AdminCard className="admin-order-cost-estimate-card">
      <AdminSectionHeader
        icon={<Receipt size={18} strokeWidth={1.7} aria-hidden />}
        title="Себестоимость"
        hint={version != null ? `v${version}` : undefined}
        actions={
          isLocked ? (
            <AdminStatusBadge tone="muted">read-only</AdminStatusBadge>
          ) : undefined
        }
      />
      {!hasEstimate ? (
        <div className="admin-muted admin-order-cost-estimate-card__empty">
          Себестоимость заказа ещё не зафиксирована. Нажмите
          «Завершить расчёт» после того, как закупщик заполнит цены и
          количества по строкам.
        </div>
      ) : (
        <>
          <dl className="admin-deflist admin-order-cost-estimate-card__summary">
            <dt>Итого</dt>
            <dd>
              <strong>{formatRub(totalRub)}</strong>
            </dd>
            <dt>Завершён</dt>
            <dd>{formatDate(completedAt)}</dd>
            {estimate?.completedByName && (
              <>
                <dt>Кто</dt>
                <dd>{estimate.completedByName}</dd>
              </>
            )}
            {estimate?.usdRateRub && (
              <>
                <dt>Курс USD</dt>
                <dd>{estimate.usdRateRub}</dd>
              </>
            )}
          </dl>
          {estimate && (
            <Breakdown estimate={estimate} />
          )}
        </>
      )}
      {/*
        Этап «Цена продажи за единицу»: блок выручки/маржи живёт в
        этой же карточке, чтобы менеджер видел «себестоимость vs
        продажа» одним взглядом. Read-only — менять цену можно
        из `/admin/orders/[id]/edit`.
      */}
      <CustomerPriceSection order={order} costRub={totalRub} />
    </AdminCard>
  );
}

function CustomerPriceSection({
  order,
  costRub,
}: {
  order: OrderDetailDto;
  costRub: string | number | null | undefined;
}) {
  const priceRaw = order.customerUnitPrice ?? null;
  const currency =
    (order.customerCurrency ?? null) as 'RUB' | 'USD' | null;
  const totalQty = order.qtyPlanTotal;

  // Если цены нет — компактная подсказка, как «нет себестоимости».
  if (priceRaw == null || priceRaw === '' || Number(priceRaw) <= 0) {
    return (
      <div className="admin-order-cost-estimate-card__sale">
        <h3 className="admin-order-cost-estimate-card__sale-title">
          Продажа
        </h3>
        <p className="admin-muted" style={{ margin: 0 }}>
          Цена продажи не указана. Заполните её в форме редактирования
          заказа, чтобы видеть выручку и маржу.
        </p>
      </div>
    );
  }

  const priceNum = Number(priceRaw);
  const revenue = Number.isFinite(priceNum) ? priceNum * totalQty : null;
  const isRub = (currency ?? 'RUB') === 'RUB';
  const costNum = costRub == null ? null : Number(costRub);
  // Маржа считается только если выручка и себестоимость в одной
  // валюте (а себестоимость у нас всегда в RUB) — для USD-цены
  // маржа в рублях без курса не считается.
  const marginRub =
    isRub && revenue != null && costNum != null
      ? revenue - costNum
      : null;

  return (
    <div className="admin-order-cost-estimate-card__sale">
      <h3 className="admin-order-cost-estimate-card__sale-title">
        Продажа
      </h3>
      <dl className="admin-deflist admin-order-cost-estimate-card__sale-list">
        <dt>Цена продажи за единицу</dt>
        <dd>
          <strong>{formatMoney(priceRaw, currency)}</strong>
        </dd>
        <dt>Количество</dt>
        <dd>{totalQty.toLocaleString('ru-RU')} шт</dd>
        <dt>Выручка</dt>
        <dd>
          <strong>{formatMoney(revenue, currency)}</strong>
        </dd>
        <dt>Себестоимость</dt>
        <dd>{costRub == null ? '—' : formatRub(costRub)}</dd>
        <dt>Маржа</dt>
        <dd>
          {marginRub == null ? (
            <span className="admin-muted">
              {isRub
                ? 'нужна себестоимость'
                : 'для USD-цены курс не задан'}
            </span>
          ) : (
            <strong
              style={{
                color:
                  marginRub >= 0
                    ? 'var(--admin-success-fg, #047857)'
                    : 'var(--admin-danger-fg, #b91c1c)',
              }}
            >
              {formatRub(marginRub)}
            </strong>
          )}
        </dd>
      </dl>
    </div>
  );
}

function Breakdown({ estimate }: { estimate: OrderCostEstimateDto }) {
  const buckets = bucketLines(estimate);
  const order: OrderCostEstimateLineKind[] = [
    'MATERIAL',
    'HARDWARE',
    'APPLICATION',
    'OTHER',
  ];
  return (
    <div className="admin-order-cost-estimate-card__breakdown">
      {order.map((k) => (
        <div
          key={k}
          className="admin-order-cost-estimate-card__breakdown-row"
        >
          <span>{ORDER_COST_ESTIMATE_LINE_KIND_LABELS[k]}</span>
          <strong>{formatRub(buckets[k])}</strong>
        </div>
      ))}
      <div className="admin-order-cost-estimate-card__lines-count admin-muted">
        Всего строк: {estimate.lines.length}
      </div>
    </div>
  );
}
