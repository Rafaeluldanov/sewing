/**
 * Прямая себестоимость: план → факт по заказу
 * (`/admin/production-cost/materials-fact`, Себестоимость Фаза 2, срезы 1–2).
 *
 * Read-модель:
 *   - МАТЕРИАЛЫ — план из активного `OrderCostEstimate` (или потребности
 *     цеха), факт из POSTED-приёмок (`receivedQty × priceSnapshot`→RUB);
 *   - ТРУД — план `Order.operationCostPlanRub`, факт Σ `OperationEntry`
 *     APPROVED по заказу;
 *   - ПРЯМАЯ С/С = материалы + труд.
 * Backend: `GET /api/costs/actual-materials`. Себестоимость потребляет
 * факт (приёмки, выработка); проводок не пишет. Показаны заказы с приёмками.
 */
import Link from 'next/link';
import { ArrowLeft, PackageSearch } from 'lucide-react';
import {
  MATERIAL_FACT_WARNING_LABELS,
  MATERIAL_PLAN_SOURCE_LABELS,
  type OrderActualMaterialsRowDto,
} from '@sewing/shared/order-actual-materials';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderActualMaterials } from '@/lib/order-actual-materials-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

function formatRub(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function varianceColor(value: string): string {
  const n = Number(value);
  if (n > 0) return 'var(--admin-danger, #b91c1c)'; // перерасход
  if (n < 0) return 'var(--admin-success, #15803d)'; // экономия
  return 'inherit';
}

function Money({ value }: { value: string }) {
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {formatRub(value)} ₽
    </span>
  );
}

export default async function MaterialsFactPage() {
  let report: Awaited<ReturnType<typeof getOrderActualMaterials>> = {
    rows: [],
    totalPlanRub: '0.00',
    totalFactRub: '0.00',
    totalVarianceRub: '0.00',
    totalPlanLaborRub: '0.00',
    totalFactLaborRub: '0.00',
    totalPlanDirectRub: '0.00',
    totalFactDirectRub: '0.00',
    totalVarianceDirectRub: '0.00',
    totalOverheadRub: '0.00',
    totalFullCostFactRub: '0.00',
  };
  let error: string | null = null;
  try {
    report = await getOrderActualMaterials();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить отчёт по себестоимости';
  }

  return (
    <AdminPageShell
      icon={<PackageSearch size={22} strokeWidth={1.6} aria-hidden />}
      title="Прямая себестоимость: план → факт"
      subtitle={`Прямая с/с факт: ${formatRub(report.totalFactDirectRub)} ₽ · Накладные: ${formatRub(report.totalOverheadRub)} ₽ · Полная с/с факт: ${formatRub(report.totalFullCostFactRub)} ₽`}
      actions={
        <Link
          href="/admin/production-cost"
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К себестоимости
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <AdminCard>
        <AdminSectionHeader title="По заказам" hint={`${report.rows.length}`} />
        <p className="admin-muted" style={{ marginTop: 0 }}>
          Материалы — фактически принятые по заказу (POSTED-приёмки). Труд —
          фактическая сдельная выработка (APPROVED). Прямая себестоимость =
          материалы + труд. Накладные (OUT-проводки журнала по статьям с
          признаком «накладные») распределены на заказы пропорционально
          прямой себестоимости; полная = прямая + накладные. Показаны заказы
          с приёмками.
        </p>
        <MaterialsTable rows={report.rows} />
      </AdminCard>
    </AdminPageShell>
  );
}

function MaterialsTable({ rows }: { rows: OrderActualMaterialsRowDto[] }) {
  const columns: AdminTableColumn<OrderActualMaterialsRowDto>[] = [
    {
      key: 'order',
      header: 'Заказ',
      render: (r) => (
        <Link
          href={`/admin/orders/${r.orderId}`}
          className="admin-table__primary"
          title={`План материалов: ${MATERIAL_PLAN_SOURCE_LABELS[r.planSource]}`}
        >
          {r.orderNumber}
        </Link>
      ),
    },
    {
      key: 'matFact',
      header: 'Материалы (факт)',
      align: 'right',
      render: (r) => <Money value={r.factMaterialsRub} />,
    },
    {
      key: 'laborFact',
      header: 'Труд (факт)',
      align: 'right',
      render: (r) => <Money value={r.factLaborRub} />,
    },
    {
      key: 'directPlan',
      header: 'Прямая: план',
      align: 'right',
      render: (r) => <Money value={r.planDirectRub} />,
    },
    {
      key: 'directFact',
      header: 'Прямая: факт',
      align: 'right',
      render: (r) => (
        <strong>
          <Money value={r.factDirectRub} />
        </strong>
      ),
    },
    {
      key: 'variance',
      header: 'Δ (факт − план)',
      align: 'right',
      render: (r) => (
        <span
          style={{
            color: varianceColor(r.varianceDirectRub),
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Number(r.varianceDirectRub) > 0 ? '+' : ''}
          {formatRub(r.varianceDirectRub)} ₽
        </span>
      ),
    },
    {
      key: 'overhead',
      header: 'Накладные',
      align: 'right',
      render: (r) =>
        Number(r.overheadRub) > 0 ? (
          <Money value={r.overheadRub} />
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'fullCost',
      header: 'Полная (факт)',
      align: 'right',
      render: (r) => (
        <strong>
          <Money value={r.fullCostFactRub} />
        </strong>
      ),
    },
    {
      key: 'warnings',
      header: '',
      render: (r) =>
        r.warnings.length > 0 ? (
          <span
            className="admin-muted"
            style={{ fontSize: 12 }}
            title={r.warnings
              .map((w) => MATERIAL_FACT_WARNING_LABELS[w] ?? w)
              .join('; ')}
          >
            ⚠ {r.warnings.length}
          </span>
        ) : null,
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.orderId}
      rowHref={(r) => `/admin/orders/${r.orderId}`}
      emptyContent={
        <AdminEmptyState
          icon={<PackageSearch size={26} strokeWidth={1.6} aria-hidden />}
          title="Нет данных"
          hint="Отчёт появится, когда по заказам будут проведённые приёмки материалов."
        />
      }
    />
  );
}
