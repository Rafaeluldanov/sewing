/**
 * `OrderOperationsTab` — вкладка «Операции» в карточке заказа
 * `/admin/orders/[id]`.
 *
 * После рефакторинга «единый рабочий экран по операциям» вкладка
 * рендерит ровно одну вещь:
 *
 *   - `OrderOperationsUnifiedTable` — компактная таблица операций
 *     заказа (№ / Операция / Статус / План / Ожидает / В работе /
 *     Выполнено / Норма / Цена / Время / Стоимость / Комментарий) +
 *     компактный итоговый блок снизу (стоимость / время / узкое место
 *     / рекомендация по сотрудникам).
 *
 * Что НЕ рендерим (требование ТЗ):
 *   - отдельную карточку «Маршрут» (`AdminRouteSteps` как stand-alone
 *     блок) — данные уже в первой колонке таблицы;
 *   - отдельную карточку «План операций»
 *     (`OrderOperationPlanBlock` — встроен в итог под таблицей);
 *   - отдельную карточку «Производственная цепочка»
 *     (`ProductionBalanceCard` — узкое место и рекомендация по
 *     сотрудникам встроены в итог).
 *
 * Backend / Prisma / OperationPlan formulas / ProductionBalanceService
 * / payroll / Passport / OperationEntry — НЕ менялись.
 */
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import { OrderOperationsUnifiedTable } from '@/components/orders/operations/order-operations-unified-table';

interface Props {
  order: OrderDetailDto;
  passports: PassportListItemDto[];
}

export function OrderOperationsTab({ order, passports }: Props) {
  return <OrderOperationsUnifiedTable order={order} passports={passports} />;
}
