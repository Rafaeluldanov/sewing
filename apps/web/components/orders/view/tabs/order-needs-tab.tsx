/**
 * `OrderNeedsTab` — вкладка «Потребности» управленческой карточки
 * `/admin/orders/[id]?tab=needs`.
 *
 * Owns material requirements + procurement + receipts + outsource
 * для одного заказа. Это единственный экран, где менеджер видит
 * конкретные материалы заказа.
 *
 * Содержимое вкладки:
 *   - материалы заказа (snapshot `OrderMaterialRequirement[]`) +
 *     потребность цеха + готовность к крою + закупки —
 *     через `OrderMaterialsUnifiedTable`. Это **canonical source of
 *     truth** по материалам в этой вкладке;
 *   - ручная разблокировка выдачи кроя
 *     (`ManualMaterialArrivalActions`);
 *   - фактический расход материалов — документы `MaterialIssue` /
 *     `MaterialIssueLine` (frontend-итерация MVP). Рендерится через
 *     `MaterialIssuesSection` ПОСЛЕ `OrderMaterialsUnifiedTable` и
 *     `ManualMaterialArrivalActions`. UI-решение владельца: блок
 *     живёт ТОЛЬКО здесь, отдельная страница
 *     `/admin/material-issues` и новая вкладка сознательно НЕ
 *     создаются;
 *   - внешние подряды (snapshot `OrderOutsourceRequirement[]`) —
 *     через `OrderOutsourceList` (action-кнопки доступны менеджерам);
 *   - агрегированный блок плановой себестоимости
 *     (`OrderPlannedCostSummaryCard`) — только итоги (материалы /
 *     фурнитура / нанесение / операции / итого + «за 1 изделие»),
 *     без построчного breakdown.
 *
 * Что СОЗНАТЕЛЬНО НЕ показываем (важно для устранения дублирования):
 *
 *   IMPORTANT: do not render `OrderSummaryUnifiedTable` here.
 *   It contains itemized material/operation rows
 *   ("Раздел / Статья / Кол-во / Цена / Сумма за тираж / Доля")
 *   and duplicates the materials already shown by
 *   `OrderMaterialsUnifiedTable`. Needs owns material requirements
 *   only; full itemized cost breakdown belongs to a dedicated cost
 *   screen (e.g. `/admin/orders/:id/cost`) or stays as an
 *   aggregate-only totals card. Никакой `hideKpiBar` / `hideRows` /
 *   `needsMode` флаг это правило не отменяет — компонент
 *   `OrderSummaryUnifiedTable` концептуально принадлежит cost-screen,
 *   а не Needs.
 *
 *   Также сюда не попадают:
 *   - размерный production-breakdown (вкладка «Производство»);
 *   - список паспортов (вкладка «Паспорта»);
 *   - snapshot маршрута / лекала (вкладка «План»);
 *   - выручка / маржа / маржинальность (это либо Header KPI, либо
 *     отдельный cost deep-dive).
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import { Wrench } from 'lucide-react';
import type {
  MaterialIssueDetailDto,
  MaterialIssueListItemDto,
} from '@sewing/shared/material-issues';
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
} from '@/components/admin';
import type { OrderExtraCostDto } from '@sewing/shared/order-extra-costs';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import {
  getMaterialIssue,
  listOrderMaterialIssues,
} from '@/lib/material-issues-api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';
import { listOrderExtraCosts } from '@/lib/order-extra-costs-api';
import { ManualMaterialArrivalActions } from '@/components/orders/materials/manual-material-arrival-actions';
import { OrderMaterialCorrections } from '@/components/orders/materials/order-material-corrections';
import { MaterialIssuesSection } from '@/components/orders/material-issues/material-issues-section';
import { OrderMaterialsUnifiedTable } from '@/components/orders/materials/order-materials-unified-table';
import { OrderCalcNeedsComparison } from '@/components/orders/calculations/order-calc-needs-comparison';
import { isOrderCalculationsEnabled } from '@/lib/feature-flags';
import { OrderPlannedCostSummaryCard } from '@/components/orders/order-planned-cost-summary-card';
import { OrderOutsourceList } from '@/components/orders/view/order-outsource-list';

interface Props {
  order: OrderDetailDto;
  /**
   * Паспорта заказа. Используются как опциональный select в
   * `CreateMaterialIssueDialog` (блок «Фактический расход
   * материалов»). `AdminOrderDetailPage` уже подгружает этот
   * список для соседних вкладок (Production / Passports), сюда
   * мы пробрасываем тот же массив — повторный fetch не нужен.
   */
  passports: PassportListItemDto[];
  /** Для action-кнопок в внешних подрядах. */
  canManage: boolean;
}

export async function OrderNeedsTab({ order, passports, canManage }: Props) {
  const noNeeds =
    order.materialRequirements.length === 0 &&
    order.outsourceRequirements.length === 0;

  // Frontend-итерация «план/факт» (см. ТЗ): MaterialIssue нужны
  // и в `OrderMaterialsUnifiedTable` (для агрегата факта по
  // `WorkshopNeed`), и в `MaterialIssuesSection` (для таблицы
  // документов и preview строк). Variant A — грузим один раз
  // здесь и пробрасываем в оба компонента, чтобы не делать
  // повторный `GET /api/orders/:id/material-issues` и N+1
  // `GET /api/material-issues/:id`. Если запрос упал — секция
  // покажет error-баннер из своего fallback-пути, а таблица
  // продолжит работать с пустым агрегатом.
  let materialIssueItems: MaterialIssueListItemDto[] = [];
  try {
    materialIssueItems = await listOrderMaterialIssues(order.id);
  } catch {
    materialIssueItems = [];
  }
  const detailEntries = await Promise.all(
    materialIssueItems.map(async (item) => {
      try {
        const detail = await getMaterialIssue(item.id);
        return [item.id, detail] as const;
      } catch {
        return [item.id, undefined] as const;
      }
    }),
  );
  const materialIssueDetails: Record<
    string,
    MaterialIssueDetailDto | undefined
  > = {};
  for (const [id, detail] of detailEntries) materialIssueDetails[id] = detail;
  const materialIssues: MaterialIssueDetailDto[] = detailEntries
    .map(([, d]) => d)
    .filter((d): d is MaterialIssueDetailDto => d !== undefined);

  // Этап «Корректировка материалов после просчёта»: ручные строки
  // потребности + прочие расходы. Грузим только для менеджеров и только
  // в статусах, где корректировка разрешена (см.
  // `assertOrderMaterialCorrectionAllowed` на бэке) — на DRAFT/DONE/
  // CANCELLED блок не нужен. Падение fetch-а не валит вкладку.
  const correctionAllowed =
    canManage &&
    (order.status === 'CALCULATION' ||
      order.status === 'CALCULATION_DONE' ||
      order.status === 'IN_PRODUCTION');
  let manualNeeds: WorkshopNeedListItemDto[] = [];
  let extraCosts: OrderExtraCostDto[] = [];
  if (correctionAllowed) {
    try {
      const needs = await getOrderWorkshopNeeds(order.id);
      manualNeeds = needs.filter((n) => n.isManual);
    } catch {
      manualNeeds = [];
    }
    try {
      extraCosts = await listOrderExtraCosts(order.id);
    } catch {
      extraCosts = [];
    }
  }

  return (
    <div className="order-needs-tab">
      {noNeeds && order.status === 'DRAFT' ? (
        <AdminCard>
          <AdminSectionHeader
            icon={<Wrench size={18} strokeWidth={1.7} aria-hidden />}
            title="Потребности"
          />
          <AdminEmptyState
            icon={<Wrench size={26} strokeWidth={1.6} aria-hidden />}
            title="Потребности появятся после расчёта"
            hint="Snapshot материалов и внешних подрядов фиксируется при переводе заказа в статус «Расчёт»."
          />
        </AdminCard>
      ) : (
        <>
          {/*
            Канонический источник правды по материалам этого заказа:
            одна общая таблица (роль / описание / чистая / к закупке /
            цена / сумма / принято / в ячейках / статус / поставщик /
            комментарий). Backend не меняли. Если у заказа нет строк,
            внутри есть собственный empty-state.

            Do not render OrderSummaryUnifiedTable here: it contains
            itemized material/operation rows and duplicates this
            table. Needs owns material requirements only; itemized
            cost breakdown belongs to a dedicated cost screen or
            aggregate-only totals card.
          */}
          <OrderMaterialsUnifiedTable
            orderId={order.id}
            materialIssues={materialIssues}
            materialsAndHardwareCostPolicy={
              order.materialsAndHardwareCostPolicy ?? 'INCLUDE'
            }
          />

          {/*
            Фича «Варианты просчёта» (итерация 2): потребности живут per
            вариант. Канонический вид выше — только активный вариант;
            этот блок даёт сравнение всех вариантов (рендерится, когда
            вариантов больше одного).
          */}
          {isOrderCalculationsEnabled() && (
            <OrderCalcNeedsComparison orderId={order.id} />
          )}

          <ManualMaterialArrivalActions
            orderId={order.id}
            orderStatus={order.status}
          />

          {correctionAllowed && (
            <OrderMaterialCorrections
              orderId={order.id}
              orderStatus={order.status}
              manualNeeds={manualNeeds}
              extraCosts={extraCosts}
              hasActiveCostEstimate={order.currentCostEstimate != null}
            />
          )}

          {/*
            Фактический расход материалов — документы MaterialIssue /
            MaterialIssueLine. UI-решение владельца (frontend-итерация
            MVP): блок живёт ТОЛЬКО здесь, во вкладке «Потребности».
            Отдельная страница `/admin/material-issues`, новый пункт
            меню и новая вкладка НЕ создаются. Backend уже реализован
            (см. `apps/api/src/modules/material-issues/*`,
            `docs/api.md §20a «Material issues»`); складских остатков
            и автосписания нет и в этой итерации — они сознательно
            вынесены в следующие итерации.

            Раздел сознательно идёт ПОСЛЕ `OrderMaterialsUnifiedTable`
            (canonical material requirements) и
            `ManualMaterialArrivalActions` — материальные потребности
            остаются первыми в визуальной иерархии, документы расхода
            — под ними как следующий шаг «выдаём в крой».
          */}
          <MaterialIssuesSection
            orderId={order.id}
            canManage={canManage}
            passports={passports}
            preloadedItems={materialIssueItems}
            preloadedIssueDetails={materialIssueDetails}
          />

          {/*
            Внешние подряды — отдельный блок, потому что snapshot
            outsource живёт на самом заказе (`order.outsourceRequirements`)
            и действия по нему (отметить как заказано / получено)
            выполняются прямо здесь.
          */}
          <OrderOutsourceList
            orderId={order.id}
            items={order.outsourceRequirements}
            canManage={canManage}
          />

          {/*
            Aggregate-only cost totals: компактный блок «Плановая
            себестоимость» (материалы / фурнитура / нанесение /
            операции / итого + «за 1 изделие»). Это не построчный
            cost breakdown — он не повторяет материалы / операции
            таблицей, не показывает выручку / маржу и не использует
            buildOrderMaterialRows / buildOrderOperationRows /
            buildOrderSummaryRows. Полный itemized breakdown
            (Раздел / Статья / Кол-во / Цена / Сумма за тираж / Доля)
            живёт в отдельном cost deep-dive компоненте — не здесь.
          */}
          <OrderPlannedCostSummaryCard order={order} />
        </>
      )}
    </div>
  );
}
