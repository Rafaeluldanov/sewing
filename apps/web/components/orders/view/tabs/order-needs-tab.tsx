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
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
} from '@/components/admin';
import { ManualMaterialArrivalActions } from '@/components/orders/materials/manual-material-arrival-actions';
import { OrderMaterialsUnifiedTable } from '@/components/orders/materials/order-materials-unified-table';
import { OrderPlannedCostSummaryCard } from '@/components/orders/order-planned-cost-summary-card';
import { OrderOutsourceList } from '@/components/orders/view/order-outsource-list';

interface Props {
  order: OrderDetailDto;
  /**
   * Сейчас Needs не использует список паспортов (он нужен соседним
   * вкладкам — Production / Passports). Параметр оставлен в сигнатуре,
   * чтобы `page.tsx` мог пробрасывать одни и те же данные во все
   * вкладки, не зная заранее кому они нужны. Если в будущем Needs
   * перестанет получать `passports` от родителя — поле можно убрать.
   */
  passports: PassportListItemDto[];
  /** Для action-кнопок в внешних подрядах. */
  canManage: boolean;
}

export function OrderNeedsTab({ order, passports: _passports, canManage }: Props) {
  void _passports;
  const noNeeds =
    order.materialRequirements.length === 0 &&
    order.outsourceRequirements.length === 0;

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
          <OrderMaterialsUnifiedTable orderId={order.id} />
          <ManualMaterialArrivalActions
            orderId={order.id}
            orderStatus={order.status}
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
