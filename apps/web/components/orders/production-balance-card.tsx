/**
 * `ProductionBalanceCard` — блок «Производственная цепочка» на
 * карточке заказа `/admin/orders/[id]` (см.
 * `apps/api/src/modules/orders/order-production-balance.service.ts`,
 * `apps/api/src/modules/orders/orders.controller.ts::getProductionBalance`).
 *
 * Серверный компонент: грузит computed-балансировку через
 * `getOrderProductionBalance(orderId)`. Если backend упал — рисуем
 * error-box и не валим карточку заказа (по тем же принципам, что
 * `WorkshopNeedsCard` / `CutReadinessCard`).
 *
 * Default-режим — `LINE_BALANCE` («Балансировка по текущему штату»).
 * Карточка показывает:
 *   1. Сводка: «Выпуск за смену», «Плановых смен», «Узкое место»,
 *      «Доступно сотрудников».
 *   2. Блок «Рекомендация» — top-1 предложение «куда добавить +1
 *      сотрудника» (или подсказка, что добавление не поможет).
 *   3. Блок «Текущая расстановка» — чипсы «Категория · N».
 *   4. Таблица операций с колонками
 *      `Операция | Работа | Норма/шт | Сотрудников | Выпуск/смену |
 *      Загрузка | Простой | Узкое место`. У рекомендованной операции
 *      отдельный бейдж «Добавить +1».
 *   5. Warnings (включая дисклеймер «параллельная оценка»).
 *
 * Что НЕ делает:
 *   - не пишет в БД;
 *   - не назначает конкретных сотрудников по именам, только
 *     количество людей на операцию;
 *   - не трогает payroll, Passport, OperationEntry, SalaryEntry,
 *     OrderCostEstimate, WorkshopNeed, PurchaseOrder/Receipt.
 */
import { AlertTriangle, Lightbulb, Users } from 'lucide-react';
import type {
  OrderProductionBalanceDto,
  OrderProductionBalanceLineDto,
} from '@sewing/shared/order-production-balance';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { getOrderProductionBalance } from '@/lib/order-production-balance-api';
import { formatDurationSec } from '@/lib/operations-time-norm';

interface Props {
  orderId: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Шитьё',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c] ?? c;
}

function formatPlannedShifts(shifts: number | null): string {
  if (shifts == null) return '—';
  if (!Number.isFinite(shifts) || shifts <= 0) return '—';
  if (shifts >= 10) return `${Math.round(shifts)}`;
  return shifts.toFixed(1).replace(/\.0$/, '');
}

function formatPercent(p: number | null): string {
  if (p == null) return '—';
  return `${Math.round(p * 100)}%`;
}

export async function ProductionBalanceCard({ orderId }: Props) {
  let dto: OrderProductionBalanceDto;
  try {
    dto = await getOrderProductionBalance(orderId);
  } catch (e) {
    return (
      <AdminCard className="admin-order-detail-card-compact">
        <AdminSectionHeader
          icon={<Users size={18} strokeWidth={1.7} aria-hidden />}
          title="Производственная цепочка"
        />
        <div className="error-box" role="alert">
          {e instanceof ApiRequestError
            ? `Не удалось загрузить балансировку: ${e.message}`
            : 'Не удалось загрузить балансировку.'}
        </div>
      </AdminCard>
    );
  }

  const hasLines = dto.lines.length > 0;
  const hasActive = dto.lines.some((l) => (l.assignedWorkers ?? 0) > 0);
  const isLineBalance = dto.strategy === 'LINE_BALANCE';
  const recommendation = dto.recommendedAdditions[0] ?? null;

  // Группируем чипсы расстановки по категориям, чтобы менеджер видел
  // сводку «по специальностям», а не по каждой операции отдельно.
  const staffingByCategory = new Map<string, number>();
  for (const l of dto.lines) {
    const w = l.assignedWorkers ?? 0;
    if (w <= 0) continue;
    staffingByCategory.set(
      l.operationCategory,
      (staffingByCategory.get(l.operationCategory) ?? 0) + w,
    );
  }

  return (
    <AdminCard
      className="admin-order-detail-card-compact admin-order-production-balance"
      ariaLabel="Производственная цепочка заказа"
    >
      <AdminSectionHeader
        icon={<Users size={18} strokeWidth={1.7} aria-hidden />}
        title="Производственная цепочка"
        hint={
          isLineBalance
            ? 'Балансировка по текущему штату'
            : `Смена ${formatDurationSec(dto.shiftSeconds)}`
        }
      />

      {!hasLines ? (
        <AdminEmptyState
          icon={<Users size={24} strokeWidth={1.6} aria-hidden />}
          title="Балансировка не рассчитана"
          hint={dto.warnings[0] ?? 'Нет данных для балансировки.'}
        />
      ) : (
        <>
          <div
            className="admin-order-production-balance__summary"
            data-testid="order-production-balance-summary"
          >
            <SummaryStat
              label="Выпуск за смену"
              value={
                dto.expectedOutputPerShift != null
                  ? `${dto.expectedOutputPerShift.toLocaleString('ru-RU')} шт`
                  : '—'
              }
            />
            {isLineBalance ? (
              <SummaryStat
                label="Плановых смен"
                value={formatPlannedShifts(dto.plannedShifts ?? null)}
              />
            ) : (
              <SummaryStat
                label="Плановая длительность заказа"
                value={formatDurationSec(dto.orderPlannedDurationSec)}
              />
            )}
            <SummaryStat
              label="Узкое место"
              value={dto.bottleneckOperationName ?? '—'}
              tone={dto.bottleneckOperationName ? 'warning' : undefined}
            />
            {isLineBalance ? (
              <SummaryStat
                label="Доступно сотрудников"
                value={`${dto.availableWorkersTotal ?? 0}`}
              />
            ) : (
              <SummaryStat
                label="Рекомендовано сотрудников"
                value={`${dto.assignedWorkersTotal ?? 0}`}
              />
            )}
          </div>

          {isLineBalance && (
            <div
              className="admin-order-production-balance__recommendation"
              data-testid="order-production-balance-recommendation"
            >
              <div className="admin-order-production-balance__recommendation-title">
                <Lightbulb size={14} strokeWidth={1.7} aria-hidden />
                <span>Рекомендация</span>
              </div>
              {recommendation ? (
                <div className="admin-order-production-balance__recommendation-body">
                  <div>
                    <strong>
                      Рекомендуем добавить {recommendation.addWorkers} сотрудника
                      на: {recommendation.operationName}
                    </strong>
                  </div>
                  <div className="admin-muted">
                    Выпуск за смену:{' '}
                    {recommendation.currentOutputPerShift ?? 0} →{' '}
                    {recommendation.expectedOutputPerShift ?? 0} шт
                  </div>
                  <div className="admin-muted">
                    Прирост: +{recommendation.gainPerShift ?? 0} шт/смену
                  </div>
                </div>
              ) : (
                <div className="admin-muted">
                  Добавление сотрудника не увеличит выпуск по текущим данным.
                </div>
              )}
            </div>
          )}

          {!isLineBalance &&
            dto.requiredWorkersTotal != null &&
            dto.availableWorkersTotal != null && (
              <div
                className="admin-order-production-balance__recommendation"
                data-testid="order-production-balance-target-shift"
              >
                <div className="admin-order-production-balance__recommendation-title">
                  <Lightbulb size={14} strokeWidth={1.7} aria-hidden />
                  <span>Что нужно для одной смены</span>
                </div>
                <div>
                  <strong>
                    Чтобы выполнить за одну смену, нужно {dto.requiredWorkersTotal}{' '}
                    сотрудников.
                  </strong>
                </div>
                <div className="admin-muted">
                  Доступно {dto.availableWorkersTotal}.
                  {dto.missingWorkersForTargetShift != null &&
                    dto.missingWorkersForTargetShift > 0 && (
                      <> Не хватает {dto.missingWorkersForTargetShift}.</>
                    )}
                </div>
              </div>
            )}

          {hasActive && (
            <div
              className="admin-order-production-balance__staffing"
              data-testid="order-production-balance-staffing"
            >
              <div className="admin-order-production-balance__staffing-title">
                {isLineBalance
                  ? 'Текущая расстановка'
                  : 'Рекомендованная расстановка'}
              </div>
              <div className="admin-order-production-balance__staffing-row">
                {isLineBalance
                  ? Array.from(staffingByCategory).map(([cat, n]) => (
                      <span
                        key={cat}
                        className="admin-order-production-balance__staffing-chip"
                      >
                        <strong>{categoryLabel(cat)}</strong>{' '}
                        <span className="admin-muted">·</span> {n}
                      </span>
                    ))
                  : dto.lines
                      .filter((l) => (l.assignedWorkers ?? 0) > 0)
                      .map((l) => (
                        <span
                          key={l.operationId}
                          className="admin-order-production-balance__staffing-chip"
                        >
                          <strong>{l.operationName}</strong>{' '}
                          <span className="admin-muted">·</span>{' '}
                          {l.assignedWorkers}
                        </span>
                      ))}
              </div>
            </div>
          )}

          <div className="admin-order-production-balance__table-wrap">
            <BalanceTable lines={dto.lines} isLineBalance={isLineBalance} />
          </div>
        </>
      )}

      {dto.warnings.length > 0 && (
        <div
          className="admin-order-production-balance__warnings"
          data-testid="order-production-balance-warnings"
          role="status"
        >
          <div className="admin-order-production-balance__warnings-title">
            <AlertTriangle size={14} strokeWidth={1.7} aria-hidden />
            <span>Замечания по балансировке</span>
          </div>
          <ul className="admin-order-production-balance__warnings-list">
            {dto.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </AdminCard>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warning' | 'success';
}) {
  return (
    <div
      className={[
        'admin-order-production-balance__stat',
        tone ? `admin-order-production-balance__stat--${tone}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="admin-order-production-balance__stat-label">{label}</div>
      <div className="admin-order-production-balance__stat-value">{value}</div>
    </div>
  );
}

function BalanceTable({
  lines,
  isLineBalance,
}: {
  lines: OrderProductionBalanceLineDto[];
  isLineBalance: boolean;
}) {
  const columns: AdminTableColumn<OrderProductionBalanceLineDto>[] = [
    {
      key: 'operation',
      header: 'Операция',
      render: (l) => (
        <span>
          <strong>{l.operationName}</strong>
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            {categoryLabel(l.operationCategory)}
          </div>
          {l.warnings.length > 0 && (
            <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
              {l.warnings[0]}
              {l.warnings.length > 1 ? ` (+${l.warnings.length - 1})` : ''}
            </div>
          )}
        </span>
      ),
    },
    {
      key: 'work',
      header: 'Работа',
      align: 'right',
      render: (l) => formatDurationSec(l.workSec || null),
    },
    {
      key: 'avg',
      header: 'Норма/шт',
      align: 'right',
      render: (l) => formatDurationSec(l.avgSecPerUnit),
    },
    {
      key: 'workers',
      header: 'Сотрудников',
      align: 'right',
      render: (l) => (
        <strong>
          {(l.assignedWorkers ?? l.suggestedWorkers ?? 0).toLocaleString(
            'ru-RU',
          )}
        </strong>
      ),
    },
    {
      key: 'capacity',
      header: 'Выпуск/смену',
      align: 'right',
      render: (l) =>
        l.capacityPerShift != null
          ? `${l.capacityPerShift.toLocaleString('ru-RU')} шт`
          : '—',
    },
    {
      key: 'utilization',
      header: 'Загрузка',
      align: 'right',
      render: (l) =>
        l.idlePercent != null
          ? formatPercent(1 - l.idlePercent)
          : '—',
    },
    {
      key: 'idle',
      header: 'Простой',
      align: 'right',
      render: (l) => (l.idlePercent != null ? formatPercent(l.idlePercent) : '—'),
    },
    {
      key: 'bottleneck',
      header: 'Узкое место',
      render: (l) =>
        l.isBottleneck ? (
          <AdminStatusBadge tone="warning">Узкое место</AdminStatusBadge>
        ) : isLineBalance && l.recommendedToAddWorker ? (
          <AdminStatusBadge tone="success">Добавить +1</AdminStatusBadge>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
  ];
  return (
    <AdminTable
      rows={[...lines].sort((a, b) => a.routeStepIndex - b.routeStepIndex)}
      columns={columns}
      rowKey={(l) => l.operationId}
    />
  );
}
