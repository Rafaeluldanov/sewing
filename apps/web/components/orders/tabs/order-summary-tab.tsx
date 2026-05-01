/**
 * `OrderSummaryTab` — вкладка «Сводно по заказу» в управленческой
 * карточке заказа `/admin/orders/[id]?tab=costSummary`.
 *
 * Это **dedicated financial tab** — единственное место, где
 * итемизированный cost breakdown (`OrderSummaryUnifiedTable`)
 * маунтится в карточке. id вкладки — `costSummary`, чтобы явно
 * отделить новую финансовую вкладку от старого generic-summary,
 * который раньше создавал путаницу (см. JSDoc `ORDER_VIEW_TABS`).
 *
 * Цель вкладки — собрать в одном месте:
 *   - расходы (материалы / фурнитура / операции / нанесение /
 *     внешние работы);
 *   - итоговую себестоимость тиража и за 1 изделие;
 *   - цену продажи (если есть);
 *   - выручку (если есть);
 *   - прибыль и маржинальность;
 *   - предупреждения по себестоимости.
 *
 * После рефакторинга «единый рабочий экран по себестоимости» wrapper
 * рендерит ровно одну вещь:
 *
 *   - `OrderSummaryUnifiedTable` — компактная таблица сводной
 *     себестоимости (Раздел / Статья / Кол-во / Ед. / Цена / Сумма
 *     за тираж / За 1 изделие / Доля / Комментарий) с KPI-полосой
 *     сверху и итоговым блоком (Себестоимость / Продажа / Маржа)
 *     снизу.
 *
 * Что НЕ рендерим (требование ТЗ §10):
 *   - отдельную карточку `OrderCostEstimateCard` — её содержимое
 *     включено в unified-таблицу + блок «Продажа»;
 *   - отдельную карточку `OrderPlannedCostSummaryCard` — её
 *     содержимое включено в KPI и блок «Итого»;
 *   - отдельный «План операций» — операции уже строки таблицы;
 *   - отдельный «Materials block» — материалы уже строки таблицы.
 *
 * Дублирование с «Потребностями». Здесь сознательно допускается
 * показывать материалы и операции как cost rows: «Сводно по
 * заказу» владеет финансовой картиной, «Потребности» —
 * procurement state (`OrderMaterialsUnifiedTable` + закупки +
 * приёмки). Разные роли, разные колоночные модели — это не дубль.
 * Обратное направление по-прежнему запрещено: itemized cost
 * breakdown в Needs не возвращаем (см. JSDoc `OrderNeedsTab` и
 * regression-тест `admin-order-needs-no-duplication.smoke.test.ts`).
 *
 * Backend / Prisma / WorkshopNeed / OperationPlan / OrderCostEstimate /
 * payroll / Passport / PurchaseOrder / PurchaseReceipt — НЕ менялись.
 */
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import { OrderSummaryUnifiedTable } from '@/components/orders/summary/order-summary-unified-table';

interface Props {
  order: OrderDetailDto;
  passports: PassportListItemDto[];
}

export function OrderSummaryTab({ order, passports }: Props) {
  return <OrderSummaryUnifiedTable order={order} passports={passports} />;
}
