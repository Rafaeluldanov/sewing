/**
 * Управленческий отчёт «Себестоимость производства» (`/admin/production-cost`).
 *
 * См. recon `docs/production-cost-v2-recon.md` и контракт
 * `packages/shared/src/production-cost.ts`. Источник данных — новый
 * endpoint `GET /api/admin/production-cost/v2`
 * (`apps/api/src/modules/costs/production-cost-v2.controller.ts`).
 *
 * Дизайн принципы:
 *
 *   - **Главный разрез — номенклатура / лекало**, не паспорт.
 *     Паспорт — техническая производственная партия. В таблицах нет
 *     обязательной колонки «Паспорт».
 *   - **Выпуск — в единицах изделий** (`releasedQty`), а не в числе
 *     паспортов (`passportsCount`) и не как Σ `OperationEntry.qty`
 *     по всем операциям.
 *   - **Материалы подписаны честно** как «по завершённому расчёту» /
 *     «по текущей потребности» — это расчётная основа, не факт
 *     списания (модели `MaterialConsumption` / `WriteOff` нет).
 *   - **Операции — факт по начислениям** (`OperationEntry.amount`).
 *   - **Стоимость операции за 1 ед.** считается из `amount / qty`.
 *
 * Старая страница `/production-cost` (cell-фокус) и старый endpoint
 * `/api/costs/production` остаются как есть.
 */
import Link from 'next/link';
import {
  AlertTriangle,
  BarChart3,
  Box,
  CalendarRange,
  ClipboardList,
  Coins,
  Factory,
  Layers,
  PackageCheck,
  Receipt,
  Tag,
  TrendingUp,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ProductionCostFilterOptionsDto,
  ProductionCostMaterialSource,
  ProductionCostNomenclatureGroupDto,
  ProductionCostOperationLineDto,
  ProductionCostOrderGroupDto,
  ProductionCostReportDto,
  ProductionCostSalaryOperationDto,
} from '@sewing/shared/production-cost';
import { PRODUCTION_COST_MATERIAL_SOURCE_LABELS } from '@sewing/shared/production-cost';
import {
  getProductionCostFilterOptions,
  getProductionCostV2,
} from '@/lib/production-cost-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { OperationSizeMatrix } from './operation-size-matrix';
import { ProductionCostFilters } from './production-cost-filters';

export const dynamic = 'force-dynamic';

type TabKey = 'nomenclature' | 'orders' | 'operations';

interface SearchParams {
  dateFrom?: string;
  dateTo?: string;
  patternItemId?: string;
  orderId?: string;
  clientId?: string;
  employeeId?: string;
  operationId?: string;
  tab?: string;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMoney(value: string | number | null): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: string | null): string {
  if (value === null) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} %`;
}

function formatQty(value: number | null): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('ru-RU');
}

function buildHref(
  base: string,
  params: Record<string, string | undefined>,
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

const MATERIAL_SOURCE_LABEL: Record<ProductionCostMaterialSource, string> =
  PRODUCTION_COST_MATERIAL_SOURCE_LABELS;

export default async function AdminProductionCostPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const dateFrom = (searchParams.dateFrom ?? '').trim() || undefined;
  const dateTo = (searchParams.dateTo ?? '').trim() || undefined;
  const patternItemId = (searchParams.patternItemId ?? '').trim() || undefined;
  const orderId = (searchParams.orderId ?? '').trim() || undefined;
  const clientId = (searchParams.clientId ?? '').trim() || undefined;
  const employeeId = (searchParams.employeeId ?? '').trim() || undefined;
  const operationId = (searchParams.operationId ?? '').trim() || undefined;
  const tab = normalizeTab(searchParams.tab);

  let data: ProductionCostReportDto | null = null;
  let error: string | null = null;
  try {
    data = await getProductionCostV2({
      dateFrom,
      dateTo,
      patternItemId,
      orderId,
      clientId,
      employeeId,
      operationId,
    });
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : 'Не удалось загрузить отчёт по себестоимости';
  }

  // Справочники для выпадающих фильтров (combobox). Не критичны: при
  // ошибке combobox просто будут пустыми, отчёт работает.
  let filterOptions: ProductionCostFilterOptionsDto = {
    patterns: [],
    orders: [],
    clients: [],
    employees: [],
    operations: [],
  };
  try {
    filterOptions = await getProductionCostFilterOptions();
  } catch {
    // ignore — fallback к пустым спискам
  }

  const hasFilters = Boolean(
    dateFrom ||
      dateTo ||
      patternItemId ||
      orderId ||
      clientId ||
      employeeId ||
      operationId,
  );

  const tabHrefBase: Record<TabKey, string> = {
    nomenclature: buildHref('/admin/production-cost', {
      dateFrom,
      dateTo,
      patternItemId,
      orderId,
      clientId,
      employeeId,
      operationId,
      tab: 'nomenclature',
    }),
    orders: buildHref('/admin/production-cost', {
      dateFrom,
      dateTo,
      patternItemId,
      orderId,
      clientId,
      employeeId,
      operationId,
      tab: 'orders',
    }),
    operations: buildHref('/admin/production-cost', {
      dateFrom,
      dateTo,
      patternItemId,
      orderId,
      clientId,
      employeeId,
      operationId,
      tab: 'operations',
    }),
  };

  return (
    <AdminPageShell
      icon={<Box size={22} strokeWidth={1.6} aria-hidden />}
      title="Себестоимость производства"
      subtitle="По номенклатуре, заказам, операциям и сотрудникам"
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Link
            href="/admin/production-cost/materials-fact"
            className="admin-btn"
          >
            Материалы: план → факт
          </Link>
          <Link
            href="/admin/production-cost/report"
            className="admin-btn admin-btn--ghost"
          >
            Отчёт
          </Link>
        </div>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {data && (
        <>
          <AdminCard compact>
            <div className="admin-section-header">
              <h2 className="admin-section-title">
                <CalendarRange size={16} strokeWidth={1.6} aria-hidden />
                Период: {formatDate(data.dateFrom)} —{' '}
                {formatDate(data.dateTo)}
              </h2>
            </div>

            <ProductionCostFilters
              tab={tab}
              dateFrom={dateFrom}
              dateTo={dateTo}
              patternItemId={patternItemId}
              orderId={orderId}
              clientId={clientId}
              employeeId={employeeId}
              operationId={operationId}
              hasFilters={hasFilters}
              options={filterOptions}
            />
          </AdminCard>

          {data.warnings.length > 0 && (
            <AdminCard compact>
              <div
                role="status"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  color: 'var(--admin-orange-fg)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                  }}
                >
                  <AlertTriangle size={14} strokeWidth={1.6} aria-hidden />
                  Замечания по данным
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            </AdminCard>
          )}

          <section aria-label="Сводка" className="admin-stack">
            <div className="admin-kpi-grid">
              <CostKpi
                tone="green"
                Icon={PackageCheck}
                label="Выпущено, шт"
                value={formatQty(data.totals.releasedQty)}
                hint={`${data.totals.ordersCount} ${pluralizeOrders(
                  data.totals.ordersCount,
                )}`}
              />
              <CostKpi
                tone="blue"
                Icon={Coins}
                label="Выручка"
                value={`${formatMoney(data.totals.revenueRub)} ₽`}
                hint={
                  data.totals.releasedQty > 0
                    ? 'Σ customerUnitPrice (RUB) × выпуск'
                    : 'Нет выпуска за период'
                }
              />
              <CostKpi
                tone="purple"
                Icon={Tag}
                label="Себестоимость"
                value={`${formatMoney(data.totals.totalCostRub)} ₽`}
                hint={
                  data.totals.unitCostRub
                    ? `За 1 изделие: ${formatMoney(
                        data.totals.unitCostRub,
                      )} ₽`
                    : 'Нет выпуска за период'
                }
              />
              <CostKpi
                tone={
                  Number(data.totals.marginRub) >= 0 ? 'green' : 'orange'
                }
                Icon={TrendingUp}
                label="Маржа"
                value={`${formatMoney(data.totals.marginRub)} ₽`}
                hint={
                  data.totals.marginPercent !== null
                    ? formatPercent(data.totals.marginPercent)
                    : '—'
                }
              />
              <CostKpi
                tone="blue"
                Icon={Factory}
                label="Операции, факт"
                value={`${formatMoney(
                  data.totals.operationPieceworkCostRub,
                )} ₽`}
                hint="Σ OperationEntry.amount (APPROVED)"
              />
              <CostKpi
                tone="purple"
                Icon={Layers}
                label="Материалы, расчёт"
                value={`${formatMoney(
                  Number(data.totals.materialCostRub) +
                    Number(data.totals.hardwareCostRub) +
                    Number(data.totals.applicationCostRub) +
                    Number(data.totals.otherCostRub),
                )} ₽`}
                hint="По завершённому расчёту / текущей потребности"
              />
            </div>
          </section>

          <AdminCard compact>
            <div className="admin-tabs" role="tablist">
              <TabLink
                active={tab === 'nomenclature'}
                href={tabHrefBase.nomenclature}
                Icon={Layers}
                label="По номенклатуре"
              />
              <TabLink
                active={tab === 'orders'}
                href={tabHrefBase.orders}
                Icon={ClipboardList}
                label="По заказам"
              />
              <TabLink
                active={tab === 'operations'}
                href={tabHrefBase.operations}
                Icon={Users}
                label="Операции / сотрудники"
              />
            </div>
          </AdminCard>

          {tab === 'nomenclature' && (
            <NomenclatureTab groups={data.nomenclatureGroups} />
          )}
          {tab === 'orders' && <OrdersTab groups={data.orderGroups} />}
          {tab === 'operations' && (
            <OperationsTab
              lines={data.operationLines}
              salaryOperations={data.salaryOperationBreakdown}
            />
          )}
        </>
      )}
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// Tab content
// ---------------------------------------------------------------------------

function NomenclatureTab({
  groups,
}: {
  groups: ProductionCostNomenclatureGroupDto[];
}) {
  if (groups.length === 0) {
    return (
      <AdminCard>
        <AdminEmptyState
          icon={<BarChart3 size={26} strokeWidth={1.6} aria-hidden />}
          title="Нет данных"
          hint="За выбранный период по номенклатуре нет операций или выпуска."
        />
      </AdminCard>
    );
  }
  return (
    <AdminCard>
      <AdminSectionHeader
        title="По номенклатуре"
        hint={`${groups.length} ${pluralizeNomenclatures(groups.length)}`}
      />
      <div
        style={{
          fontSize: 12,
          color: 'var(--admin-muted)',
          marginBottom: 8,
        }}
      >
        Операции — факт по начислениям. Материалы — расчётная основа
        (по завершённому расчёту или по текущей потребности).
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Номенклатура</th>
              <th>Артикул</th>
              <th style={{ textAlign: 'right' }}>Выпущено, шт</th>
              <th style={{ textAlign: 'right' }}>Заказы</th>
              <th style={{ textAlign: 'right' }}>Выручка, ₽</th>
              <th style={{ textAlign: 'right' }}>Материалы, ₽</th>
              <th style={{ textAlign: 'right' }}>Фурнитура, ₽</th>
              <th style={{ textAlign: 'right' }}>Нанесение, ₽</th>
              <th style={{ textAlign: 'right' }}>Операции, ₽</th>
              <th style={{ textAlign: 'right' }}>Себестоимость, ₽</th>
              <th style={{ textAlign: 'right' }}>За 1 изделие, ₽</th>
              <th style={{ textAlign: 'right' }}>Маржа, ₽</th>
              <th style={{ textAlign: 'right' }}>Маржа %</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.nomenclatureKey}>
                <td data-label="Номенклатура">
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <strong>{g.nomenclatureName ?? '—'}</strong>
                    {g.categoryName && (
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--admin-muted)',
                        }}
                      >
                        {g.categoryName}
                      </span>
                    )}
                  </div>
                </td>
                <td data-label="Артикул">
                  {g.nomenclatureArticle ?? '—'}
                </td>
                <td data-label="Выпущено" style={{ textAlign: 'right' }}>
                  <strong>{formatQty(g.releasedQty)}</strong>
                </td>
                <td data-label="Заказы" style={{ textAlign: 'right' }}>
                  {g.ordersCount}
                </td>
                <td data-label="Выручка" style={{ textAlign: 'right' }}>
                  {formatMoney(g.revenueRub)}
                </td>
                <td data-label="Материалы" style={{ textAlign: 'right' }}>
                  {formatMoney(g.materialCostRub)}
                </td>
                <td data-label="Фурнитура" style={{ textAlign: 'right' }}>
                  {formatMoney(g.hardwareCostRub)}
                </td>
                <td data-label="Нанесение" style={{ textAlign: 'right' }}>
                  {formatMoney(g.applicationCostRub)}
                </td>
                <td data-label="Операции" style={{ textAlign: 'right' }}>
                  {formatMoney(g.operationPieceworkCostRub)}
                </td>
                <td
                  data-label="Себестоимость"
                  style={{ textAlign: 'right' }}
                >
                  <strong>{formatMoney(g.totalCostRub)}</strong>
                </td>
                <td
                  data-label="За 1 изделие"
                  style={{ textAlign: 'right' }}
                >
                  {g.unitCostRub ? formatMoney(g.unitCostRub) : '—'}
                </td>
                <td
                  data-label="Маржа"
                  style={{
                    textAlign: 'right',
                    color:
                      Number(g.marginRub) < 0
                        ? 'var(--admin-orange-fg)'
                        : undefined,
                  }}
                >
                  {formatMoney(g.marginRub)}
                </td>
                <td data-label="Маржа %" style={{ textAlign: 'right' }}>
                  {formatPercent(g.marginPercent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {groups.map((g) => (
        <OperationSizeMatrix
          key={`${g.nomenclatureKey}-matrix`}
          nomenclatureName={g.nomenclatureName}
          nomenclatureArticle={g.nomenclatureArticle}
          sizeColumns={g.sizeColumns}
          operationMatrix={g.operationMatrix}
        />
      ))}
    </AdminCard>
  );
}

function OrdersTab({ groups }: { groups: ProductionCostOrderGroupDto[] }) {
  if (groups.length === 0) {
    return (
      <AdminCard>
        <AdminEmptyState
          icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
          title="Нет данных"
          hint="За выбранный период не было выпуска или начислений."
        />
      </AdminCard>
    );
  }
  return (
    <AdminCard>
      <AdminSectionHeader
        title="По заказам"
        hint={`${groups.length} ${pluralizeOrders(groups.length)}`}
      />
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Заказ</th>
              <th>Клиент</th>
              <th>Номенклатура</th>
              <th>Цвет</th>
              <th style={{ textAlign: 'right' }}>Выпущено, шт</th>
              <th style={{ textAlign: 'right' }}>Выручка, ₽</th>
              <th style={{ textAlign: 'right' }}>Материалы, ₽</th>
              <th style={{ textAlign: 'right' }}>Операции, ₽</th>
              <th style={{ textAlign: 'right' }}>Себестоимость, ₽</th>
              <th style={{ textAlign: 'right' }}>За 1 изделие, ₽</th>
              <th style={{ textAlign: 'right' }}>Маржа, ₽</th>
              <th>Источник материалов</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.orderId}>
                <td data-label="Заказ">
                  <Link
                    href={`/admin/production-cost/order/${g.orderId}`}
                    className="admin-table__primary"
                    title="Открыть документ производства (план → факт)"
                  >
                    <strong>{g.orderNumber}</strong>
                  </Link>
                </td>
                <td data-label="Клиент">{g.clientName ?? '—'}</td>
                <td data-label="Номенклатура">
                  {g.nomenclatureName ?? '—'}
                  {g.nomenclatureArticle && (
                    <span
                      style={{
                        marginLeft: 6,
                        color: 'var(--admin-muted)',
                        fontSize: 12,
                      }}
                    >
                      ({g.nomenclatureArticle})
                    </span>
                  )}
                </td>
                <td data-label="Цвет">{g.color ?? '—'}</td>
                <td data-label="Выпущено" style={{ textAlign: 'right' }}>
                  <strong>{formatQty(g.releasedQty)}</strong>
                </td>
                <td data-label="Выручка" style={{ textAlign: 'right' }}>
                  {formatMoney(g.revenueRub)}
                </td>
                <td data-label="Материалы" style={{ textAlign: 'right' }}>
                  {formatMoney(
                    Number(g.materialCostRub) +
                      Number(g.hardwareCostRub) +
                      Number(g.applicationCostRub) +
                      Number(g.otherCostRub),
                  )}
                </td>
                <td data-label="Операции" style={{ textAlign: 'right' }}>
                  {formatMoney(g.operationPieceworkCostRub)}
                </td>
                <td
                  data-label="Себестоимость"
                  style={{ textAlign: 'right' }}
                >
                  <strong>{formatMoney(g.totalCostRub)}</strong>
                </td>
                <td
                  data-label="За 1 изделие"
                  style={{ textAlign: 'right' }}
                >
                  {g.unitCostRub ? formatMoney(g.unitCostRub) : '—'}
                </td>
                <td
                  data-label="Маржа"
                  style={{
                    textAlign: 'right',
                    color:
                      Number(g.marginRub) < 0
                        ? 'var(--admin-orange-fg)'
                        : undefined,
                  }}
                >
                  {formatMoney(g.marginRub)}
                </td>
                <td data-label="Источник">
                  <span
                    style={{ color: 'var(--admin-muted)', fontSize: 12 }}
                  >
                    {MATERIAL_SOURCE_LABEL[g.materialSource]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

function OperationsTab({
  lines,
  salaryOperations,
}: {
  lines: ProductionCostOperationLineDto[];
  salaryOperations: ProductionCostSalaryOperationDto[];
}) {
  if (lines.length === 0 && salaryOperations.length === 0) {
    return (
      <AdminCard>
        <AdminEmptyState
          icon={<Receipt size={26} strokeWidth={1.6} aria-hidden />}
          title="Нет данных"
          hint="За выбранный период начислений и окладных операций не было."
        />
      </AdminCard>
    );
  }
  return (
    <>
      <SalaryOperationsTable rows={salaryOperations} />
      {lines.length > 0 && (
        <AdminCard>
          <AdminSectionHeader
            title="Операции / сотрудники (сдельные)"
            hint={`${lines.length} ${pluralizeEntries(lines.length)}`}
          />
      <div
        style={{
          fontSize: 12,
          color: 'var(--admin-muted)',
          marginBottom: 8,
        }}
      >
        Каждая строка — одна `OperationEntry` (факт по начислениям).
        Стоимость операции за 1 ед. = сумма / количество.
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Номенклатура</th>
              <th>Заказ</th>
              <th>Клиент</th>
              <th>Размер</th>
              <th>Операция</th>
              <th>Сотрудник</th>
              <th style={{ textAlign: 'right' }}>Кол-во</th>
              <th style={{ textAlign: 'right' }}>Ставка</th>
              <th style={{ textAlign: 'right' }}>Сумма, ₽</th>
              <th style={{ textAlign: 'right' }}>За 1 ед., ₽</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.operationEntryId}>
                <td data-label="Дата">{formatDateTime(l.date)}</td>
                <td data-label="Номенклатура">
                  {l.nomenclatureName ?? '—'}
                  {l.nomenclatureArticle && (
                    <span
                      style={{
                        marginLeft: 6,
                        color: 'var(--admin-muted)',
                        fontSize: 12,
                      }}
                    >
                      ({l.nomenclatureArticle})
                    </span>
                  )}
                </td>
                <td
                  data-label="Заказ"
                  title={l.passportNumber ? `Тех. партия: ${l.passportNumber}` : undefined}
                >
                  {l.orderNumber}
                </td>
                <td data-label="Клиент">{l.clientName ?? '—'}</td>
                <td data-label="Размер">{l.sizeCode}</td>
                <td data-label="Операция">{l.operationName}</td>
                <td data-label="Сотрудник">{l.employeeName}</td>
                <td data-label="Кол-во" style={{ textAlign: 'right' }}>
                  {formatQty(l.qty)}
                </td>
                <td data-label="Ставка" style={{ textAlign: 'right' }}>
                  {formatMoney(l.ratePerUnit)}
                </td>
                <td data-label="Сумма" style={{ textAlign: 'right' }}>
                  <strong>{formatMoney(l.amount)}</strong>
                </td>
                <td data-label="За 1 ед." style={{ textAlign: 'right' }}>
                  {l.unitCost ? formatMoney(l.unitCost) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        </AdminCard>
      )}
    </>
  );
}

/**
 * Таблица окладных операций (ОТК / ВТО / Упаковка / Деление кроя).
 * У них нет `OperationEntry`, поэтому стоимость берётся из разнесённого
 * реального времени (`PassportRealCostService`): минуты × оклад/480.
 */
function SalaryOperationsTable({
  rows,
}: {
  rows: ProductionCostSalaryOperationDto[];
}) {
  if (rows.length === 0) return null;
  return (
    <AdminCard>
      <AdminSectionHeader
        title="Окладные операции (по времени)"
        hint={`${rows.length} ${pluralizeEntries(rows.length)}`}
      />
      <div
        style={{
          fontSize: 12,
          color: 'var(--admin-muted)',
          marginBottom: 8,
        }}
      >
        ОТК / ВТО / Упаковка / Деление кроя — без сдельных начислений.
        Стоимость = разнесённое реальное время × (оклад / 480).
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Операция</th>
              <th style={{ textAlign: 'right' }}>Время, мин</th>
              <th style={{ textAlign: 'right' }}>₽ / мин</th>
              <th style={{ textAlign: 'right' }}>Сумма, ₽</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.operationId}>
                <td data-label="Операция">{r.operationName}</td>
                <td data-label="Время" style={{ textAlign: 'right' }}>
                  {formatQty(r.minutes)}
                </td>
                <td data-label="₽ / мин" style={{ textAlign: 'right' }}>
                  {r.rubPerMinute ? formatMoney(r.rubPerMinute) : '—'}
                </td>
                <td data-label="Сумма" style={{ textAlign: 'right' }}>
                  <strong>{formatMoney(r.rub)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTab(value: string | undefined): TabKey {
  if (value === 'orders' || value === 'operations') return value;
  return 'nomenclature';
}

function pluralizeOrders(n: number): string {
  const pr = new Intl.PluralRules('ru-RU');
  const c = pr.select(n);
  if (c === 'one') return 'заказ';
  if (c === 'few') return 'заказа';
  return 'заказов';
}

function pluralizeNomenclatures(n: number): string {
  const pr = new Intl.PluralRules('ru-RU');
  const c = pr.select(n);
  if (c === 'one') return 'номенклатура';
  if (c === 'few') return 'номенклатуры';
  return 'номенклатур';
}

function pluralizeEntries(n: number): string {
  const pr = new Intl.PluralRules('ru-RU');
  const c = pr.select(n);
  if (c === 'one') return 'начисление';
  if (c === 'few') return 'начисления';
  return 'начислений';
}

interface CostKpiProps {
  tone: 'blue' | 'green' | 'orange' | 'purple';
  Icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
}

const KPI_CARD_TONE: Record<CostKpiProps['tone'], string> = {
  blue: 'admin-kpi-card--blue',
  green: 'admin-kpi-card--green',
  orange: 'admin-kpi-card--orange',
  purple: 'admin-kpi-card--purple',
};

const KPI_BUBBLE_TONE: Record<CostKpiProps['tone'], string> = {
  blue: 'admin-accent-blue',
  green: 'admin-accent-green',
  orange: 'admin-accent-orange',
  purple: 'admin-accent-purple',
};

function CostKpi({ tone, Icon, label, value, hint }: CostKpiProps) {
  return (
    <div className={`admin-kpi-card ${KPI_CARD_TONE[tone]}`}>
      <div className="admin-kpi-card__head">
        <span
          className={`admin-kpi-card__bubble ${KPI_BUBBLE_TONE[tone]}`}
          aria-hidden
        >
          <Icon size={16} strokeWidth={1.6} />
        </span>
        {label}
      </div>
      <div className="admin-kpi-card__value">{value}</div>
      {hint && <div className="admin-kpi-card__sub">{hint}</div>}
    </div>
  );
}

function TabLink({
  active,
  href,
  Icon,
  label,
}: {
  active: boolean;
  href: string;
  Icon: LucideIcon;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`admin-tab ${active ? 'admin-tab--active' : ''}`}
      role="tab"
      aria-selected={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        borderBottom: active
          ? '2px solid var(--admin-accent)'
          : '2px solid transparent',
        color: active ? 'var(--admin-fg)' : 'var(--admin-muted)',
        textDecoration: 'none',
        fontWeight: active ? 600 : 500,
      }}
    >
      <Icon size={14} strokeWidth={1.6} aria-hidden />
      {label}
    </Link>
  );
}
