/**
 * Контракты вкладки «Заказы» кабинета мастера
 * (`apps/api/src/modules/master-orders/*`, `apps/web/app/master`).
 *
 * Зачем отдельный контракт, а не `GET /orders`. Список заказов
 * (`OrderListItemDto`) — это управленческий DTO: себестоимость, клиент,
 * склад, freshness плана, и ручка под `@Roles('SHOP_MANAGER')`. Мастеру
 * нужен другой срез и другой объём прав: номер, изделие, срок, сколько
 * упаковано и КАКОЙ У ЗАКАЗА МАРШРУТ — чтобы прямо со списка увидеть,
 * что в заказе нет ОТК, и поправить это холстом
 * (`PUT /orders/:id/amendments/route`).
 *
 * Маршрут едет прямо в строке списка сознательно: у мастера телефон, и
 * «открыть заказ, чтобы посмотреть цепочку» — это лишний экран на каждый
 * из десятка заказов смены. Мини-цепочка + отметка фронта отвечают на
 * вопрос «где партия и что дальше» без единого тапа.
 *
 * Подразделением НЕ фильтруем — ровно как «Движение тиража» и
 * «Расхождения» (`master/production-board`): у мастера один цех, и
 * второй фильтр к нему был бы настройкой, о которой некому договориться.
 *
 * Read-only: сервис только читает. Единственная мутация фичи — правка
 * маршрута, и она идёт существующей ручкой order-amendments, а не сюда.
 */

import { z } from 'zod';
import type { OrderStatus } from './orders';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Вкладки списка. Не статус заказа, а ответ на вопрос мастера:
 *   - `production` — по этим заказам сегодня шьют (правка маршрута идёт
 *     с фронтом производства и обязательной причиной);
 *   - `pending` — крой ещё не выдан, маршрут правится целиком и без
 *     причины: это лучшее время что-то в нём поменять;
 *   - `done` — закрытые, только посмотреть (маршрут уже не правится).
 */
export const MASTER_ORDER_TABS = ['production', 'pending', 'done'] as const;
export type MasterOrderTab = (typeof MASTER_ORDER_TABS)[number];

/**
 * Статусы каждой вкладки — источник истины для бэкенда и для подписи
 * вкладки в UI. `CANCELLED` не входит никуда: отменённый заказ мастеру
 * в цеху не нужен, а его архив живёт в админке.
 */
export const MASTER_ORDER_TAB_STATUSES: Record<
  MasterOrderTab,
  readonly OrderStatus[]
> = {
  production: ['SAMPLE_PRODUCTION', 'IN_PRODUCTION'],
  pending: ['DRAFT', 'CALCULATION', 'CALCULATION_DONE'],
  done: ['DONE'],
};

export const MasterOrdersQuerySchema = z.object({
  tab: z.enum(MASTER_ORDER_TABS).default('production'),
  /** Поиск по номеру заказа, изделию и клиенту (регистронезависимо). */
  search: z.string().trim().max(120).optional(),
});
export type MasterOrdersQuery = z.infer<typeof MasterOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * Шаг маршрута для мини-цепочки в карточке списка. Полей ровно столько,
 * сколько рисует чип: холст правки читает своё состояние отдельной
 * ручкой (`GET /orders/:id/amendments/operations`), дублировать его
 * расценки и нормы в списке незачем.
 */
export interface MasterOrderRouteStepDto {
  index: number;
  operationCode: string;
  operationName: string;
  /** Категория операции — цвет чипа (`routeStepTone`). */
  operationCategory: string | null;
  /** Номер параллельной группы: соседние шаги с одним номером — один этап. */
  parallelGroup: number | null;
  /**
   * Шаг пройден или проходится сейчас (`index <= frontierIndex`) — в UI
   * серый с замком. Тот же признак, по которому холст замораживает
   * префикс, поэтому считается из одного фронта, а не отдельным правилом.
   */
  passed: boolean;
}

export interface MasterOrderListItemDto {
  id: string;
  number: string;
  status: OrderStatus;
  /** Изделие первой позиции заказа (в списке заказ = одно изделие). */
  productName: string | null;
  color: string | null;
  clientName: string | null;
  /** ISO-дата срока сдачи; `null` — срок не зафиксирован. */
  dueDate: string | null;
  /** ISO-момент запуска в производство; `null` — ещё не запущен. */
  inProductionAt: string | null;
  qtyPlanTotal: number;
  /** Σ `Passport.qtyGood` по упакованным паспортам — прогресс выпуска. */
  qtyFinishedTotal: number;
  /** Сколько паспортов выпущено по заказу (не отменённых). */
  passportCount: number;
  /**
   * Фронт производства: максимальный `currentRouteStepIndex` живых
   * паспортов, −1 если паспортов нет. Та же величина, что в
   * `OperationAmendmentStateDto.frontierIndex`.
   */
  frontierIndex: number;
  /** Маршрут можно править (`ORDER_ROUTE_EDITABLE_STATUSES`). */
  routeEditable: boolean;
  /** Заказ запущен: у правки появляется фронт и обязательная причина. */
  started: boolean;
  steps: MasterOrderRouteStepDto[];
}

export interface MasterOrdersDto {
  items: MasterOrderListItemDto[];
  /** Счётчики по вкладкам — считаются всегда, поиск на них не влияет. */
  counts: Record<MasterOrderTab, number>;
}
