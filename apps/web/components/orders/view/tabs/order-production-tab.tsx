/**
 * `OrderProductionTab` — вкладка «Производство» управленческой
 * карточки `/admin/orders/[id]?tab=production`.
 *
 * ПРОТОТИП объединённой таблицы (см. обсуждение «объединить три
 * таблицы вкладки производство»). Раньше срез заказа жил в ТРЁХ
 * раздельных таблицах:
 *   - «По размерам»  — плановая воронка (`OrderSizeBreakdownRow[]`):
 *     план / раскроено / Δ / брак — НАКОПИТЕЛЬНЫЕ величины;
 *   - «Цех сейчас»   — где паспорта стоят ПРЯМО СЕЙЧАС
 *     (`GET /api/shopfloor/state`, бакеты CUT/SEWING/QC/QC_DONE/…);
 *   - «Отгрузка» (превью балансов готовой продукции).
 *
 * Теперь это ОДНА матрица «размер × этап» (`ProductionMatrix`) со
 * сгруппированной шапкой, читаемая слева направо как сквозная
 * воронка: План → В цеху сейчас → Отгрузка. Группа «В цеху сейчас»
 * повторяет модель доски монитора — на каждом этапе показываем
 * «▶ в работе сейчас» (красным) и «✔ выполнено, ждёт следующий шаг»
 * (зелёным буфером). Данные `*_DONE` для этого уже есть в
 * `ShopfloorRowDto` — бэкенд не трогаем.
 *
 * Что СОЗНАТЕЛЬНО остаётся отдельно:
 *   - ЖУРНАЛ отгрузок (`OrderFinishedGoodsShipmentSection`) — это лог
 *     событий (дата / номер / статус / отмена), а не разрез по
 *     размеру, в матрицу его впихивать нельзя. Превью балансов из
 *     него переехало в колонку «К отгрузке».
 *   - список паспортов (вкладка «Паспорта»), материалы (вкладка
 *     «Потребности»), hero-метрики (шапка).
 *
 * Backend / DTO / Prisma здесь не задействованы — это presentation-
 * слой, склейка трёх готовых read-only проекций по `sizeId`.
 */
import type {
  OrderDetailDto,
  OrderRouteStepDto,
  OrderSizeBreakdownRow,
  OrderSummary,
} from '@sewing/shared/orders';
import type { OrderCutIssueRulesSummaryDto } from '@sewing/shared';
import type {
  ShopfloorRowDto,
  ShopfloorStateDto,
} from '@sewing/shared/shopfloor';
import {
  AdminCard,
  AdminEmptyState,
  AdminRouteSteps,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import { getShopfloorState } from '@/lib/shopfloor-api';
import {
  listFinishedGoodsBalances,
  listOrderFinishedGoodsShipments,
} from '@/lib/finished-goods-api';
import { Activity, BarChart3, Layers, Lock, Workflow } from 'lucide-react';
import { OrderFinishedGoodsShipmentSection } from '@/components/orders/finished-goods/order-finished-goods-shipment-section';
import { OrderMaterialColorsCard } from '@/components/orders/view/order-material-colors-card';
import { OrderCutIssueRulesCard } from '@/components/orders/order-cut-issue-rules-card';
import { RouteModeToggle } from '@/components/orders/view/route-mode-toggle';

interface Props {
  order: OrderDetailDto;
  /**
   * ADMIN / SHOP_MANAGER — определяет видимость кнопки «Создать
   * отгрузку» в блоке готовой продукции и управление блоками «Цвета
   * по строкам техкарты» / «Очередь выдачи кроя» (переехали сюда из
   * удалённой вкладки «План»). Layout `/admin/*` уже пускает только
   * этих ролей, флаг нужен для симметрии с остальными action-блоками
   * карточки заказа.
   */
  canManage: boolean;
  /**
   * Сводка «Очередь выдачи кроя по размерам» (см.
   * `apps/web/components/orders/order-cut-issue-rules-card.tsx`).
   * Получаем готовой из admin-page (`/admin/orders/[id]`), чтобы не
   * делать дополнительный запрос внутри tab-компонента. Раньше блок
   * жил во вкладке «План».
   */
  cutIssueRulesSummary: OrderCutIssueRulesSummaryDto;
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
      tone: summary.qtyDeltaTotal === 0 ? 'neutral' : 'warning',
      hint:
        summary.qtyDeltaTotal === 0
          ? null
          : summary.qtyDeltaTotal > 0
            ? 'Раскроено больше плана — план иммутабельный (ADR-0006).'
            : 'Раскроено меньше плана — раскройщик ещё не закрыл норму.',
    },
  ];
}

export async function OrderProductionTab({
  order,
  canManage,
  cutIssueRulesSummary,
}: Props) {
  // Stage buckets имеют смысл только когда заказ реально едет в
  // производстве: до запуска (DRAFT/CALCULATION/CALCULATION_DONE)
  // паспортов нет, проекция пуста, а endpoint `/api/shopfloor/state`
  // на DRAFT-заказ может отдать 4xx. После CANCELLED тоже грузить
  // незачем. Подключаем только для `IN_PRODUCTION` и `DONE`.
  const shopfloorEligible =
    order.status === 'IN_PRODUCTION' || order.status === 'DONE';
  // Маршрут — snapshot после запуска (ADR-0006): показываем плашку
  // «snapshot» в тех же статусах, что и на бывшей вкладке «План».
  const isStarted =
    order.status === 'IN_PRODUCTION' ||
    order.status === 'DONE' ||
    order.status === 'CANCELLED';

  let shopfloor: ShopfloorStateDto | null = null;
  let shopfloorError: string | null = null;
  if (shopfloorEligible) {
    try {
      shopfloor = await getShopfloorState(order.id);
    } catch (e) {
      shopfloorError =
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось получить состояние цеха';
    }
  }

  // «Готово к отгрузке» (остаток на складе ГП) и «Отгружено» (Σ
  // POSTED-строк отгрузок) сводим к уровню размера, чтобы показать
  // хвост воронки прямо в матрице. Оба endpoint-а — read-only списки,
  // фильтрованные по orderId; на DRAFT просто отдают пусто, поэтому
  // грузим всегда и мягко деградируем при ошибке.
  const readyToShipBySize = new Map<string, number>();
  const shippedBySize = new Map<string, number>();
  try {
    const balances = await listFinishedGoodsBalances({
      orderId: order.id,
      positiveOnly: true,
      limit: 200,
    });
    for (const b of balances.items) {
      readyToShipBySize.set(
        b.sizeId,
        (readyToShipBySize.get(b.sizeId) ?? 0) + b.qty,
      );
    }
  } catch {
    // Колонка «К отгрузке» останется пустой — не роняем весь срез.
  }
  try {
    const shipments = await listOrderFinishedGoodsShipments(order.id);
    for (const s of shipments) {
      if (s.status !== 'POSTED') continue;
      for (const line of s.lines) {
        shippedBySize.set(
          line.sizeId,
          (shippedBySize.get(line.sizeId) ?? 0) + line.qty,
        );
      }
    }
  } catch {
    // Колонка «Отгружено» останется пустой.
  }

  const kpis = buildKpis(order.summary);
  const shopBySize = new Map<string, ShopfloorRowDto>();
  if (shopfloor) {
    for (const r of shopfloor.rows) shopBySize.set(r.sizeId, r);
  }

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

      <AdminCard className="admin-order-detail-card-compact">
        <AdminSectionHeader
          icon={<Workflow size={18} strokeWidth={1.7} aria-hidden />}
          title="Маршрут операций"
          hint={order.routeTemplateName ?? order.techCardName ?? undefined}
          actions={
            isStarted ? (
              <AdminStatusBadge tone="muted">
                <Lock size={12} strokeWidth={1.7} aria-hidden /> snapshot
              </AdminStatusBadge>
            ) : null
          }
        />
        <dl className="admin-deflist">
          <dt>Шаблон маршрута</dt>
          <dd>
            {order.routeTemplateName ? (
              <strong>{order.routeTemplateName}</strong>
            ) : (
              <span className="admin-muted">не выбран</span>
            )}
          </dd>
          <dt>Шаблон техкарты</dt>
          <dd>
            {order.techCardName ? (
              <strong>{order.techCardName}</strong>
            ) : (
              <span className="admin-muted">не выбран</span>
            )}
          </dd>
        </dl>
        {(order.routeTemplateName?.toLowerCase().includes('сплит') ||
          order.routeModeOverride !== 'AUTO') && (
          <div className="order-plan-tab__route-mode">
            <span className="admin-deflist__subtitle">Режим распошива</span>
            <RouteModeToggle
              orderId={order.id}
              current={order.routeModeOverride}
            />
          </div>
        )}
        <RouteStepsList steps={order.routeSteps} />
        {order.operationPlanIsStale && (
          <p className="admin-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
            <Layers size={12} strokeWidth={1.7} aria-hidden /> План операций
            устарел:{' '}
            {order.operationPlanStaleReason ??
              'после расчёта менялись операции, ставки или нормы времени.'}
          </p>
        )}
      </AdminCard>

      <AdminCard className="order-prod-tab__matrix-card">
        <AdminSectionHeader
          icon={<Activity size={18} strokeWidth={1.7} aria-hidden />}
          title="Производство по размерам"
          hint={
            shopfloor
              ? `Цех: срез ${formatTime(shopfloor.updatedAt)}`
              : 'План и отгрузка; цех — после запуска'
          }
        />
        {shopfloorError && (
          <p className="order-prod-tab__shopfloor-warning">
            Не удалось получить срез цеха: {shopfloorError}. Колонки
            «В цеху сейчас» пусты, остальной срез показан.
          </p>
        )}
        {order.sizeBreakdown.length === 0 ? (
          <AdminEmptyState
            icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
            title="План по размерам не заполнен"
            hint="Добавьте строки в плане — затем заказ можно перевести в расчёт."
          />
        ) : (
          <ProductionMatrix
            rows={order.sizeBreakdown}
            shopBySize={shopBySize}
            shopfloorEligible={shopfloorEligible}
            readyToShipBySize={readyToShipBySize}
            shippedBySize={shippedBySize}
          />
        )}
      </AdminCard>

      {/*
       * Журнал отгрузок остаётся отдельно: это лог документов
       * (дата / номер / отмена), не разрез по размеру. Превью
       * балансов из него переехало в колонку «К отгрузке» матрицы.
       */}
      <OrderFinishedGoodsShipmentSection
        orderId={order.id}
        canManage={canManage}
      />

      {/*
       * Блоки «Цвета по строкам техкарты» и «Очередь выдачи кроя по
       * размерам» переехали сюда из удалённой вкладки «План» (см.
       * `OrderMaterialColorsCard`, `OrderCutIssueRulesCard`). По
       * просьбе — в самом конце вкладки «Производство»: это
       * настроечные блоки, идут после основного производственного
       * среза и журнала отгрузок.
       */}
      <OrderMaterialColorsCard order={order} />

      <OrderCutIssueRulesCard
        orderId={order.id}
        orderItems={order.items}
        initialSummary={cutIssueRulesSummary}
        canManage={canManage}
      />
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

interface ProductionMatrixProps {
  rows: OrderSizeBreakdownRow[];
  shopBySize: Map<string, ShopfloorRowDto>;
  /** До запуска в производство колонки «В цеху сейчас» = прочерк. */
  shopfloorEligible: boolean;
  readyToShipBySize: Map<string, number>;
  shippedBySize: Map<string, number>;
}

/**
 * Объединённая матрица «размер × этап» — единый источник истины
 * производственного среза заказа. Склеивает три проекции по `sizeId`:
 * план (`OrderSizeBreakdownRow`), живой цех (`ShopfloorRowDto`) и
 * хвост отгрузки (балансы ГП + Σ POSTED-отгрузок).
 *
 * Группа «В цеху сейчас» повторяет доску монитора: ▶ — в работе на
 * этапе сейчас (красным), ✔ — выполнено и ждёт следующий шаг (буфер,
 * зелёным). Бакет CUT = «раскроено, ждёт швею» → показываем как ✔
 * (готов к пошиву); SEWING/PACKING — только ▶ (промежуточного
 * «done»-бакета у них в проекции нет); QC/WTO — пара ▶/✔.
 */
function ProductionMatrix({
  rows,
  shopBySize,
  shopfloorEligible,
  readyToShipBySize,
  shippedBySize,
}: ProductionMatrixProps) {
  const sorted = [...rows].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);

  // Итоги по колонкам — собираем за один проход.
  const totals = {
    plan: 0,
    cut: 0,
    delta: 0,
    defect: 0,
    wCut: 0,
    wSew: 0,
    wQc: 0,
    wQcDone: 0,
    wWto: 0,
    wWtoDone: 0,
    wPack: 0,
    finished: 0,
    ready: 0,
    shipped: 0,
  };

  const body = sorted.map((r) => {
    const sf = shopBySize.get(r.sizeId);
    const ready = readyToShipBySize.get(r.sizeId) ?? 0;
    const shipped = shippedBySize.get(r.sizeId) ?? 0;

    totals.plan += r.qtyPlan;
    totals.cut += r.qtyCutFact;
    totals.delta += r.qtyDelta;
    totals.defect += r.qtyDefect;
    totals.finished += r.qtyFinished;
    totals.ready += ready;
    totals.shipped += shipped;
    if (sf) {
      totals.wCut += sf.qtyCut;
      totals.wSew += sf.qtySewing;
      totals.wQc += sf.qtyQc;
      totals.wQcDone += sf.qtyQcDone;
      totals.wWto += sf.qtyWto;
      totals.wWtoDone += sf.qtyWtoDone;
      totals.wPack += sf.qtyPacking;
    }

    return (
      <tr key={r.sizeId}>
        <th scope="row" className="order-prod-matrix__size">
          {r.sizeCode}
        </th>
        {/* План */}
        <td className="order-prod-matrix__num">{r.qtyPlan}</td>
        <td className="order-prod-matrix__num">{r.qtyCutFact}</td>
        <td className="order-prod-matrix__num">
          <DeltaValue value={r.qtyDelta} />
        </td>
        <td className="order-prod-matrix__num order-prod-matrix__group-end">
          <span style={{ color: r.qtyDefect > 0 ? '#b91c1c' : undefined }}>
            {r.qtyDefect}
          </span>
        </td>
        {/* В цеху сейчас (▶ в работе / ✔ готово к следующему шагу) */}
        <WipCell eligible={shopfloorEligible} done={sf?.qtyCut} />
        <WipCell eligible={shopfloorEligible} now={sf?.qtySewing} />
        <WipCell
          eligible={shopfloorEligible}
          now={sf?.qtyQc}
          done={sf?.qtyQcDone}
        />
        <WipCell
          eligible={shopfloorEligible}
          now={sf?.qtyWto}
          done={sf?.qtyWtoDone}
        />
        <WipCell
          eligible={shopfloorEligible}
          now={sf?.qtyPacking}
          groupEnd
        />
        {/* Отгрузка */}
        <td className="order-prod-matrix__num order-prod-matrix__finished">
          {r.qtyFinished}
        </td>
        <td className="order-prod-matrix__num order-prod-matrix__ready">
          {ready}
        </td>
        <td className="order-prod-matrix__num">{shipped}</td>
      </tr>
    );
  });

  return (
    <div className="order-prod-matrix__scroll">
      <table className="order-prod-matrix">
        <thead>
          <tr className="order-prod-matrix__group-row">
            <th rowSpan={2} className="order-prod-matrix__size">
              Размер
            </th>
            <th colSpan={4} className="order-prod-matrix__group">
              План
            </th>
            <th
              colSpan={5}
              className="order-prod-matrix__group order-prod-matrix__group--wip"
            >
              В цеху сейчас <span className="order-prod-matrix__legend">▶ в работе · ✔ готово</span>
            </th>
            <th
              colSpan={3}
              className="order-prod-matrix__group order-prod-matrix__group--ship"
            >
              Отгрузка
            </th>
          </tr>
          <tr className="order-prod-matrix__sub-row">
            <th>План</th>
            <th>Раскр.</th>
            <th>Δ</th>
            <th className="order-prod-matrix__group-end">Брак</th>
            <th>Крой</th>
            <th>Пошив</th>
            <th>ОТК</th>
            <th>ВТО</th>
            <th className="order-prod-matrix__group-end">Упак.</th>
            <th>Выпущено</th>
            <th>К отгр.</th>
            <th>Отгруж.</th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
        <tfoot>
          <tr className="order-prod-matrix__totals">
            <th scope="row" className="order-prod-matrix__size">
              Итого
            </th>
            <td className="order-prod-matrix__num">{totals.plan}</td>
            <td className="order-prod-matrix__num">{totals.cut}</td>
            <td className="order-prod-matrix__num">
              <DeltaValue value={totals.delta} />
            </td>
            <td className="order-prod-matrix__num order-prod-matrix__group-end">
              {totals.defect}
            </td>
            <WipCell eligible={shopfloorEligible} done={totals.wCut} foot />
            <WipCell eligible={shopfloorEligible} now={totals.wSew} foot />
            <WipCell
              eligible={shopfloorEligible}
              now={totals.wQc}
              done={totals.wQcDone}
              foot
            />
            <WipCell
              eligible={shopfloorEligible}
              now={totals.wWto}
              done={totals.wWtoDone}
              foot
            />
            <WipCell
              eligible={shopfloorEligible}
              now={totals.wPack}
              groupEnd
              foot
            />
            <td className="order-prod-matrix__num order-prod-matrix__finished">
              {totals.finished}
            </td>
            <td className="order-prod-matrix__num order-prod-matrix__ready">
              {totals.ready}
            </td>
            <td className="order-prod-matrix__num">{totals.shipped}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RouteStepsList({ steps }: { steps: OrderRouteStepDto[] }) {
  if (steps.length === 0) {
    return (
      <p className="admin-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
        Маршрут не зафиксирован — заказ ещё не запущен либо запущен без
        шаблона.
      </p>
    );
  }
  const adminSteps = [...steps]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      id: s.id,
      index: s.index + 1,
      name: s.operationName,
    }));
  return (
    <div style={{ marginTop: 8 }}>
      <AdminRouteSteps steps={adminSteps} dense />
    </div>
  );
}

function DeltaValue({ value }: { value: number }) {
  return (
    <span
      style={{
        color: value === 0 ? undefined : value > 0 ? '#1f7a1f' : '#b91c1c',
      }}
    >
      {value}
    </span>
  );
}

interface WipCellProps {
  eligible: boolean;
  /** ▶ — в работе на этапе сейчас (красным). */
  now?: number;
  /** ✔ — выполнено, ждёт следующий шаг (буфер, зелёным). */
  done?: number;
  /** Правая граница группы «В цеху сейчас». */
  groupEnd?: boolean;
  /** Строка итогов — приглушаем фон. */
  foot?: boolean;
}

/**
 * Ячейка этапа группы «В цеху сейчас». Повторяет доску монитора:
 * красная плашка «▶ N» (в работе) и/или зелёная «✔ N» (готово к
 * следующему шагу). До запуска в производство — прочерк; на этапе
 * без движения — приглушённая точка.
 */
function WipCell({ eligible, now, done, groupEnd, foot }: WipCellProps) {
  const cls = [
    'order-prod-matrix__num',
    'order-prod-matrix__wip',
    groupEnd ? 'order-prod-matrix__group-end' : '',
    foot ? 'order-prod-matrix__wip--foot' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!eligible) {
    return (
      <td className={cls}>
        <span className="order-prod-matrix__wip-empty">—</span>
      </td>
    );
  }

  const n = now ?? 0;
  const d = done ?? 0;
  if (n === 0 && d === 0) {
    return (
      <td className={cls}>
        <span className="order-prod-matrix__wip-empty">·</span>
      </td>
    );
  }

  return (
    <td className={cls}>
      <span className="order-prod-matrix__wip-chips">
        {n > 0 && (
          <span className="order-prod-matrix__chip order-prod-matrix__chip--now">
            ▶ {n}
          </span>
        )}
        {d > 0 && (
          <span className="order-prod-matrix__chip order-prod-matrix__chip--done">
            ✔ {d}
          </span>
        )}
      </span>
    </td>
  );
}
