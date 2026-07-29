/**
 * Типизированные обёртки поверх `apiFetch` под эндпоинты заказов.
 *
 * Все функции — серверные. Page-компоненты вызывают их из RSC;
 * формы пишут server actions, которые уже внутри дёргают эти функции.
 */

import type {
  CreateOrderDto,
  CreateOrderLogisticsLineDto,
  ListOrdersQuery,
  OrderDetailDto,
  OrderListResponse,
  OrderOutsourceExecutionStatus,
  OrderStatus,
  ProductDto,
  SetOrderRouteModeDto,
  SizeDto,
  UpdateOrderDto,
  UpdateOrderLogisticsLineDto,
} from '@sewing/shared/orders';
import type {
  CompleteOrderCalculationDto,
  OrderCostEstimateDto,
  ReopenOrderCalculationDto,
} from '@sewing/shared/order-cost-estimates';
import type { UpdateOrderRouteOverridesDto } from '@sewing/shared/routes';
import type { OrderTransitionDto } from '@sewing/shared/order-transitions';
import { apiFetch } from './api';

export function listOrders(
  query: Partial<ListOrdersQuery> = {},
): Promise<OrderListResponse> {
  return apiFetch<OrderListResponse>('/orders', {
    searchParams: {
      search: query.search,
      status: query.status,
      // Управленческие фильтры: `deadline` (бакет «контроля сроков»,
      // см. `OrdersService.list`) и `clientId` (карточка клиента,
      // блок «Заказы клиента»). Проброшены здесь, чтобы web-обёртка
      // покрывала весь `ListOrdersQuerySchema`.
      deadline: query.deadline,
      clientId: query.clientId,
      companyDivisionId: query.companyDivisionId,
      // Вкладка «Активные» / «Архив» списка `/admin/orders`. Без
      // параметра ручка отдаёт заказы всех статусов — на это
      // рассчитывают дашборд и блок «Заказы клиента».
      tab: query.tab,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
    },
  });
}

export function getOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}`);
}

/**
 * Переходы статуса заказа без сборки карточки
 * (`GET /api/orders/:id/transitions`). Тот же массив, что в
 * `OrderDetailDto.availableTransitions`.
 *
 * Нужен контролу «Статус заказа» в строке списка `/admin/orders`:
 * список заказов НЕ отдаёт переходы по каждой строке (это N × гейты на
 * рендер), поэтому строка догружает их лениво — по открытию списка.
 */
export function getOrderTransitions(
  id: string,
): Promise<OrderTransitionDto[]> {
  return apiFetch<OrderTransitionDto[]>(
    `/orders/${encodeURIComponent(id)}/transitions`,
  );
}

export function createOrder(body: CreateOrderDto): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>('/orders', {
    method: 'POST',
    body,
  });
}

export function updateOrder(
  id: string,
  body: UpdateOrderDto,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export function startOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
}

/**
 * Ручное переопределение адаптивного режима сплит-распошива заказа
 * (`PATCH /orders/:id/route-mode`). AUTO / FORCE_SPLIT / FORCE_COLLAPSED.
 * Работает и в IN_PRODUCTION — рантайм-настройка распошива.
 */
export function setOrderRouteMode(
  id: string,
  body: SetOrderRouteModeDto,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(id)}/route-mode`,
    {
      method: 'PATCH',
      body,
    },
  );
}

/**
 * Этап «Расчёт»: перевод заказа `DRAFT → CALCULATION` с
 * автоматическим вызовом `WorkshopNeedsService.calculateForOrder`
 * (см. `apps/api/src/modules/orders/orders.service.ts::startCalculation`).
 *
 * Бэкенд сам валидирует pattern/techCard/items и пробрасывает
 * адресные `ORDER_PATTERN_REQUIRED` / `ORDER_TECH_CARD_REQUIRED` /
 * `ORDER_ITEMS_REQUIRED` (400) или `ORDER_INVALID_STATUS_TRANSITION`
 * (409) — UI выводит их через ApiRequestError → explainApiError.
 */
export function startCalculationOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(id)}/start-calculation`,
    {
      method: 'POST',
    },
  );
}

export function completeOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
  });
}

/**
 * Этап «Себестоимость заказа»: завершение расчёта
 * (`POST /api/orders/:id/complete-calculation`). Возвращает свежий
 * `OrderCostEstimateDto`. Backend параллельно переводит заказ в
 * `CALCULATION_DONE` и заполняет snapshot-поля
 * (`Order.costEstimate*`).
 */
export function completeOrderCalculation(
  id: string,
  body: CompleteOrderCalculationDto,
): Promise<OrderCostEstimateDto> {
  return apiFetch<OrderCostEstimateDto>(
    `/orders/${encodeURIComponent(id)}/complete-calculation`,
    {
      method: 'POST',
      body,
    },
  );
}

/**
 * Этап «Себестоимость заказа»: вернуть заказ на пересчёт
 * (`POST /api/orders/:id/reopen-calculation`). Возвращает уже
 * отозванный `OrderCostEstimateDto` (status = REVOKED) или `null`,
 * если активного расчёта по заказу не было (теоретическая защита от
 * race-конкуренции — на практике контроллер требует
 * `CALCULATION_DONE`).
 */
export function reopenOrderCalculation(
  id: string,
  body: ReopenOrderCalculationDto = {},
): Promise<OrderCostEstimateDto | null> {
  return apiFetch<OrderCostEstimateDto | null>(
    `/orders/${encodeURIComponent(id)}/reopen-calculation`,
    {
      method: 'POST',
      body,
    },
  );
}

/**
 * Этап «Корректировка материалов после просчёта»: пересчитать
 * себестоимость БЕЗ смены статуса заказа
 * (`POST /api/orders/:id/recalculate-cost-estimate`). Текущий
 * `COMPLETED`-расчёт помечается `REVOKED`, создаётся новая версия из
 * актуальных `WorkshopNeed` + `OrderExtraCost`. Разрешено из
 * `CALCULATION_DONE` и `IN_PRODUCTION`. Тело — то же
 * `CompleteOrderCalculationDto` (курс USD нужен только при USD-строках).
 */
export function recalculateOrderCostEstimate(
  id: string,
  body: CompleteOrderCalculationDto = {},
): Promise<OrderCostEstimateDto> {
  return apiFetch<OrderCostEstimateDto>(
    `/orders/${encodeURIComponent(id)}/recalculate-cost-estimate`,
    {
      method: 'POST',
      body,
    },
  );
}

export function cancelOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

/**
 * Hard-delete отменённого заказа (`DELETE /orders/:id`). Backend
 * блокирует удаление, если заказ не `CANCELLED` или по нему есть
 * производственная история (409 `ORDER_DELETE_FORBIDDEN`). Тело ответа
 * пустое — возвращаем `void`.
 */
export function deleteOrder(id: string): Promise<void> {
  return apiFetch<void>(`/orders/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * Этап 2 «План операций на заказе» (см.
 * `docs/operation-time-norms-recon.md §11`,
 * `apps/api/src/modules/orders/orders.controller.ts::recalculateOperationPlan`):
 * ручной пересчёт snapshot-полей плана операций
 * (`Order.operationCostPlanRub` / `operationTimePlanSec` / …).
 *
 * Backend разрешает только `DRAFT` / `CALCULATION`, для остальных
 * статусов отдаёт 409 `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED` —
 * UI показывает inline-error через `explainApiError`.
 */
export function recalculateOrderOperationPlan(
  id: string,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(id)}/operation-plan/recalculate`,
    {
      method: 'POST',
    },
  );
}

/**
 * Этап «Указать в заказе» (см. ТЗ §4): сохранить цвет, выбранный
 * менеджером для конкретной строки материала заказа. Доступно
 * только для строк с `requiresColorSelection = true`. Backend на
 * остальных строках отвечает 409
 * `ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED`.
 */
export function updateOrderMaterialRequirementColor(
  orderId: string,
  requirementId: string,
  selectedColorText: string | null,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/material-requirements/${encodeURIComponent(
      requirementId,
    )}/color`,
    {
      method: 'PATCH',
      body: { selectedColorText },
    },
  );
}

/**
 * MVP-3 техкарт (ADR-0022 §«Manual execution status»): ручной перевод
 * операционного статуса внешней потребности заказа. Через action
 * разрешены только `ORDERED` и `RECEIVED` — линейные переходы
 * `PLANNED → ORDERED → RECEIVED`. Backend сам валидирует переход и
 * возвращает 409 на недопустимый.
 */
export function updateOrderOutsourceRequirementStatus(
  orderId: string,
  requirementId: string,
  executionStatus: Extract<OrderOutsourceExecutionStatus, 'ORDERED' | 'RECEIVED'>,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/outsource-requirements/${encodeURIComponent(
      requirementId,
    )}/status`,
    {
      method: 'POST',
      body: { executionStatus },
    },
  );
}

/**
 * Ручные строки логистики заказа (таблица «Операции» карточки заказа).
 * CRUD-обёртки поверх `/api/orders/:id/logistics-lines`. Все три ручки
 * возвращают свежий `OrderDetailDto` — server action делает
 * `revalidatePath`, и RSC перечитывает таблицу.
 */
export function addOrderLogisticsLine(
  orderId: string,
  body: CreateOrderLogisticsLineDto,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/logistics-lines`,
    {
      method: 'POST',
      body,
    },
  );
}

export function updateOrderLogisticsLine(
  orderId: string,
  lineId: string,
  body: UpdateOrderLogisticsLineDto,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/logistics-lines/${encodeURIComponent(
      lineId,
    )}`,
    {
      method: 'PATCH',
      body,
    },
  );
}

export function deleteOrderLogisticsLine(
  orderId: string,
  lineId: string,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/logistics-lines/${encodeURIComponent(
      lineId,
    )}`,
    {
      method: 'DELETE',
    },
  );
}

/**
 * Правка расценок / норм времени операций **в рамках заказа** (блок
 * «Операции» → «Редактировать маршрут заказа»). Шлёт полный набор
 * правок одним запросом (`PUT /orders/:id/route-overrides`); бэкенд
 * пишет переопределения на снимок маршрута заказа, не трогая справочник
 * операций и шаблон.
 */
export function updateOrderRouteOverrides(
  orderId: string,
  body: UpdateOrderRouteOverridesDto,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/route-overrides`,
    {
      method: 'PUT',
      body,
    },
  );
}

export function listSizes(): Promise<SizeDto[]> {
  return apiFetch<SizeDto[]>('/sizes', {
    next: { revalidate: 60, tags: ['sizes'] },
  });
}

/**
 * Создание нового размера в общем справочнике (`POST /api/sizes`).
 *
 * Этап «Создание пользовательского размера» (см. ТЗ): backend сам
 * нормализует `code` (см. `normalizeSizeCode` в `@sewing/shared/sizes`)
 * и сделает idempotent-create — повторный POST с тем же кодом
 * вернёт уже существующий размер без вставки дубля.
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`. RBAC-проверка идёт на бэке; web
 * использует обёртку из server actions, которые сами решают, кому
 * показать кнопку.
 */
export function createSize(body: {
  code: string;
  sortOrder?: number | null;
}): Promise<SizeDto> {
  return apiFetch<SizeDto>('/sizes', {
    method: 'POST',
    body,
  });
}

export function listProducts(): Promise<ProductDto[]> {
  return apiFetch<ProductDto[]>('/products', {
    next: { revalidate: 60, tags: ['products'] },
  });
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  // Этап «Расчёт» (см. `OrdersService.startCalculation`): между
  // DRAFT и IN_PRODUCTION. Лейбл совпадает с
  // `@sewing/shared/orders::ORDER_STATUS_LABELS.CALCULATION` и
  // admin-словарём `lib/admin-labels.ts`.
  CALCULATION: 'Расчёт',
  // Этап «Себестоимость заказа»: расчёт зафиксирован.
  CALCULATION_DONE: 'Расчёт завершён',
  // Этап «Производство сигнального образца»: образец запущен без
  // запуска тиража (см. `OrderSamplesService.start`).
  SAMPLE_PRODUCTION: 'Производство сигнального образца',
  IN_PRODUCTION: 'В производстве',
  DONE: 'Завершён',
  CANCELLED: 'Отменён',
};
