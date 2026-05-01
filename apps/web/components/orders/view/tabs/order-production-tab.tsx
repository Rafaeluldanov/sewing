/**
 * `OrderProductionTab` — вкладка «Производство» управленческой
 * карточки `/admin/orders/[id]?tab=production`.
 *
 * Показывает только производственный срез заказа (см. ТЗ
 * «Вкладка Производство»):
 *   - KPI «План / Раскроено / В пошиве / ОТК / ВТО / Упаковано /
 *     Выпущено / Брак / Δ» из `OrderSummary`;
 *   - таблица «по размерам» из `OrderSizeBreakdownRow[]`;
 *   - текущие stage-buckets по заказу — отдельный блок «Цех сейчас»,
 *     данные из `GET /api/shopfloor/state?orderId=…`. Backend не
 *     меняли — это уже существующая read-only проекция.
 *
 * Что СОЗНАТЕЛЬНО НЕ показываем:
 *   - список паспортов (он во вкладке «Паспорта»);
 *   - материалы / outsource / cost (вкладка «Потребности»);
 *   - метрики hero (тираж, выручка, маржа) — это в шапке.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import type {
  OrderDetailDto,
  OrderSizeBreakdownRow,
  OrderSummary,
} from '@sewing/shared/orders';
import {
  SHOPFLOOR_STAGE_LABELS,
  type ShopfloorRowDto,
  type ShopfloorStateDto,
} from '@sewing/shared/shopfloor';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { getShopfloorState } from '@/lib/shopfloor-api';
import { Activity, BarChart3, Package } from 'lucide-react';

interface Props {
  order: OrderDetailDto;
}

interface KpiCardProps {
  label: string;
  value: number;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  hint?: string | null;
}

function KpiCard({ label, value, tone = 'neutral', hint }: KpiCardProps) {
  return (
    <div
      className={`order-prod-tab__kpi order-prod-tab__kpi--${tone}`}
      title={hint ?? undefined}
    >
      <span className="order-prod-tab__kpi-label">{label}</span>
      <span className="order-prod-tab__kpi-value">
        {value.toLocaleString('ru-RU')}
      </span>
    </div>
  );
}

function buildKpis(summary: OrderSummary): KpiCardProps[] {
  return [
    { label: 'План всего', value: summary.qtyPlanTotal, tone: 'neutral' },
    { label: 'Раскроено', value: summary.qtyCutFactTotal, tone: 'neutral' },
    { label: 'В пошиве', value: summary.qtyInSewingTotal, tone: 'neutral' },
    { label: 'На ОТК', value: summary.qtyQcTotal, tone: 'neutral' },
    { label: 'На ВТО', value: summary.qtyWtoTotal, tone: 'neutral' },
    { label: 'На упаковке', value: summary.qtyPackingTotal, tone: 'neutral' },
    { label: 'Выпущено', value: summary.qtyFinishedTotal, tone: 'success' },
    {
      label: 'Брак',
      value: summary.qtyDefectTotal,
      tone: summary.qtyDefectTotal > 0 ? 'danger' : 'neutral',
    },
    {
      label: 'Δ крой − план',
      value: summary.qtyDeltaTotal,
      tone:
        summary.qtyDeltaTotal === 0
          ? 'neutral'
          : summary.qtyDeltaTotal > 0
            ? 'warning'
            : 'warning',
      hint:
        summary.qtyDeltaTotal === 0
          ? null
          : summary.qtyDeltaTotal > 0
            ? 'Раскроено больше плана — план иммутабельный (ADR-0006).'
            : 'Раскроено меньше плана — раскройщик ещё не закрыл норму.',
    },
  ];
}

export async function OrderProductionTab({ order }: Props) {
  // Stage buckets имеют смысл только когда заказ реально едет в
  // производстве: до запуска (DRAFT/CALCULATION/CALCULATION_DONE)
  // паспортов нет, проекция пуста, а endpoint `/api/shopfloor/state`
  // на DRAFT-заказ может отдать 4xx (см.
  // `apps/api/src/modules/shopfloor/shopfloor.service.ts`). После
  // CANCELLED тоже грузить незачем — только лишний round-trip.
  // Подключаем только для `IN_PRODUCTION` и `DONE`.
  const shopfloorEligible =
    order.status === 'IN_PRODUCTION' || order.status === 'DONE';

  let shopfloor: ShopfloorStateDto | null = null;
  let shopfloorError: string | null = null;
  if (shopfloorEligible) {
    try {
      shopfloor = await getShopfloorState(order.id);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        shopfloorError = `${e.message}${e.code ? ` (${e.code})` : ''}`;
      } else {
        shopfloorError = 'Не удалось получить состояние цеха';
      }
    }
  }

  const kpis = buildKpis(order.summary);

  return (
    <div className="order-prod-tab">
      <AdminCard className="order-prod-tab__kpi-card">
        <AdminSectionHeader
          icon={<BarChart3 size={18} strokeWidth={1.7} aria-hidden />}
          title="Прогресс по стадиям"
          hint="Источник: агрегаты заказа (паспорта)"
        />
        <div className="order-prod-tab__kpi-grid">
          {kpis.map((k) => (
            <KpiCard key={k.label} {...k} />
          ))}
        </div>
      </AdminCard>

      <AdminCard className="order-prod-tab__breakdown-card">
        <AdminSectionHeader
          icon={<Package size={18} strokeWidth={1.7} aria-hidden />}
          title="По размерам"
          hint={
            order.sizeBreakdown.length > 0
              ? `${order.sizeBreakdown.length} строк`
              : undefined
          }
        />
        {order.sizeBreakdown.length === 0 ? (
          <AdminEmptyState
            icon={<Package size={26} strokeWidth={1.6} aria-hidden />}
            title="План по размерам не заполнен"
            hint="Добавьте строки в плане — затем заказ можно перевести в расчёт."
          />
        ) : (
          <BreakdownTable rows={order.sizeBreakdown} />
        )}
      </AdminCard>

      <AdminCard className="order-prod-tab__shopfloor-card">
        <AdminSectionHeader
          icon={<Activity size={18} strokeWidth={1.7} aria-hidden />}
          title="Цех сейчас"
          hint={
            shopfloor
              ? `Срез: ${formatTime(shopfloor.updatedAt)}`
              : undefined
          }
        />
        {!shopfloorEligible ? (
          <AdminEmptyState
            icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
            title="Матрица цеха появится после запуска заказа в производство"
            hint={
              order.status === 'CANCELLED'
                ? 'Заказ отменён — производственная проекция не строится.'
                : 'Пока заказ в DRAFT/расчёте паспортов нет, и срез по этапам не имеет смысла. После «Запустить в производство» здесь появится живая матрица «размер × этап».'
            }
          />
        ) : shopfloorError ? (
          <p className="order-prod-tab__shopfloor-warning">
            Не удалось получить срез цеха: {shopfloorError}. Это блок
            «по живым паспортам», на остальной экран он не влияет.
          </p>
        ) : shopfloor && shopfloor.rows.length > 0 ? (
          <ShopfloorMatrix rows={shopfloor.rows} />
        ) : (
          <AdminEmptyState
            icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
            title="Пока нет живых паспортов"
            hint="Срез заполнится, когда раскройщик выпустит первую партию по этому заказу."
          />
        )}
      </AdminCard>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Таблица «по размерам» — один источник истины для производственного
 * среза заказа. Та же сетка колонок, что в legacy-`/orders/[id]`,
 * но без дублирования summary в KPI выше (KPI рисуем итогами, а
 * таблица — разбивкой).
 */
function BreakdownTable({ rows }: { rows: OrderSizeBreakdownRow[] }) {
  const sorted = [...rows].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
  const columns: AdminTableColumn<OrderSizeBreakdownRow>[] = [
    {
      key: 'size',
      header: 'Размер',
      render: (r) => <strong>{r.sizeCode}</strong>,
    },
    { key: 'plan', header: 'План', align: 'right', render: (r) => r.qtyPlan },
    {
      key: 'cut',
      header: 'Раскроено',
      align: 'right',
      render: (r) => r.qtyCutFact,
    },
    {
      key: 'inSew',
      header: 'В пошиве',
      align: 'right',
      render: (r) => r.qtyInSewing,
    },
    { key: 'qc', header: 'ОТК', align: 'right', render: (r) => r.qtyQc },
    { key: 'wto', header: 'ВТО', align: 'right', render: (r) => r.qtyWto },
    {
      key: 'pack',
      header: 'Упаковка',
      align: 'right',
      render: (r) => r.qtyPacking,
    },
    {
      key: 'finished',
      header: 'Выпущено',
      align: 'right',
      render: (r) => r.qtyFinished,
    },
    {
      key: 'defect',
      header: 'Брак',
      align: 'right',
      render: (r) => (
        <span style={{ color: r.qtyDefect > 0 ? '#b91c1c' : undefined }}>
          {r.qtyDefect}
        </span>
      ),
    },
    {
      key: 'remaining',
      header: 'Остаток',
      align: 'right',
      render: (r) => r.qtyRemaining,
    },
    {
      key: 'delta',
      header: 'Δ',
      align: 'right',
      render: (r) => (
        <span
          style={{
            color:
              r.qtyDelta === 0
                ? undefined
                : r.qtyDelta > 0
                  ? '#1f7a1f'
                  : '#b91c1c',
          }}
        >
          {r.qtyDelta}
        </span>
      ),
    },
  ];
  return <AdminTable rows={sorted} columns={columns} rowKey={(r) => r.sizeId} />;
}

/**
 * Матрица «размер × stage» по живым паспортам заказа.
 * Источник истины — `getShopfloorState(orderId)` (бакеты CUT / SEWING /
 * QC / QC_DONE / WTO / WTO_DONE / PACKING / FINISHED, см. ADR-0013).
 *
 * Это **дополняет**, а не дублирует таблицу `BreakdownTable` выше:
 * `BreakdownTable` показывает агрегаты заказа (план/факт/брак), а
 * матрица — где конкретно паспорта стоят прямо сейчас.
 */
function ShopfloorMatrix({ rows }: { rows: ShopfloorRowDto[] }) {
  const sorted = [...rows].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
  const columns: AdminTableColumn<ShopfloorRowDto>[] = [
    {
      key: 'size',
      header: 'Размер',
      render: (r) => <strong>{r.sizeCode}</strong>,
    },
    {
      key: 'cut',
      header: SHOPFLOOR_STAGE_LABELS.CUT,
      align: 'right',
      render: (r) => r.qtyCut,
    },
    {
      key: 'sew',
      header: SHOPFLOOR_STAGE_LABELS.SEWING,
      align: 'right',
      render: (r) => r.qtySewing,
    },
    {
      key: 'qc',
      header: SHOPFLOOR_STAGE_LABELS.QC,
      align: 'right',
      render: (r) => r.qtyQc,
    },
    {
      key: 'qcDone',
      header: SHOPFLOOR_STAGE_LABELS.QC_DONE,
      align: 'right',
      render: (r) => r.qtyQcDone,
    },
    {
      key: 'wto',
      header: SHOPFLOOR_STAGE_LABELS.WTO,
      align: 'right',
      render: (r) => r.qtyWto,
    },
    {
      key: 'wtoDone',
      header: SHOPFLOOR_STAGE_LABELS.WTO_DONE,
      align: 'right',
      render: (r) => r.qtyWtoDone,
    },
    {
      key: 'packing',
      header: SHOPFLOOR_STAGE_LABELS.PACKING,
      align: 'right',
      render: (r) => r.qtyPacking,
    },
    {
      key: 'finished',
      header: SHOPFLOOR_STAGE_LABELS.FINISHED,
      align: 'right',
      render: (r) => r.qtyFinished,
    },
  ];
  return <AdminTable rows={sorted} columns={columns} rowKey={(r) => r.sizeId} />;
}
