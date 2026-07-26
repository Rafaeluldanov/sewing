import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  UpdateOrderRouteOverridesSchema,
  type UpdateOrderRouteOverridesDto,
} from '@sewing/shared/routes';
import {
  CreateOrderLogisticsLineSchema,
  CreateOrderSchema,
  ListOrdersQuerySchema,
  UpdateOrderLogisticsLineSchema,
  SetOrderRouteModeSchema,
  UpdateOrderMaterialRequirementColorSchema,
  UpdateOrderOutsourceRequirementStatusSchema,
  UpdateOrderSchema,
  type CreateOrderDto,
  type CreateOrderLogisticsLineDto,
  type ListOrdersQuery,
  type SetOrderRouteModeDto,
  type UpdateOrderDto,
  type UpdateOrderLogisticsLineDto,
  type UpdateOrderMaterialRequirementColorDto,
  type UpdateOrderOutsourceRequirementStatusDto,
} from '@sewing/shared/orders';
import {
  CompleteOrderCalculationSchema,
  ReopenOrderCalculationSchema,
  type CompleteOrderCalculationDto,
  type ReopenOrderCalculationDto,
} from '@sewing/shared/order-cost-estimates';
import {
  PRODUCTION_BALANCE_STRATEGIES,
  type OrderProductionBalanceQuery,
  type ProductionBalanceStrategy,
} from '@sewing/shared/order-production-balance';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OrderCostEstimatesService } from './order-cost-estimates.service.js';
import { OrderProductionBalanceService } from './order-production-balance.service.js';
import { OrdersService } from './orders.service.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * RBAC раздела «Заказы». Согласно матрице ролей доступ к /orders есть
 * только у `ADMIN` и `SHOP_MANAGER` (см. `docs/api.md §4`,
 * `docs/screens.md §1`).
 *
 * Исключение по чтению: `CUTTER_ASSISTANT` (помощник раскройщика) —
 * единственный участник производственного флоу, кому необходимо
 * увидеть заказ, чтобы выпустить по нему паспорт. Поэтому на GET-
 * маршрутах список разрешённых ролей расширен до
 * `SHOP_MANAGER + CUTTER_ASSISTANT`. Создание/редактирование/смена
 * статуса по-прежнему доступны только менеджерам.
 */
@Controller('orders')
@Roles('SHOP_MANAGER')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly costEstimates: OrderCostEstimatesService,
    private readonly productionBalance: OrderProductionBalanceService,
  ) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.orders.create(dto, user.employeeId);
  }

  @Get()
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT')
  list(
    @Query(new ZodValidationPipe(ListOrdersQuerySchema)) query: ListOrdersQuery,
  ) {
    return this.orders.list(query);
  }

  @Get(':id')
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT')
  getOne(@Param('id') id: string) {
    return this.orders.getOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateOrderSchema)) dto: UpdateOrderDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.orders.update(id, dto, user.employeeId);
  }

  @Post(':id/start')
  start(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.orders.start(id, user.employeeId);
  }

  /**
   * Ручное переопределение адаптивного режима сплит-распошива заказа
   * (AUTO / FORCE_SPLIT / FORCE_COLLAPSED). В отличие от `update`, работает
   * и в IN_PRODUCTION — это рантайм-настройка распошива, а не состав заказа.
   * См. `OrdersService.setRouteModeOverride` и `route-mode.ts`.
   */
  @Patch(':id/route-mode')
  setRouteMode(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetOrderRouteModeSchema)) dto: SetOrderRouteModeDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.orders.setRouteModeOverride(id, dto.routeModeOverride, user.employeeId);
  }

  /**
   * Этап «Расчёт»: перевод заказа `DRAFT → CALCULATION` с
   * автоматическим вызовом `WorkshopNeedsService.calculateForOrder`.
   * RBAC — тот же `SHOP_MANAGER`/`ADMIN`, что у остальных
   * action-ручек заказа (см. `@Roles('SHOP_MANAGER')` на классе и
   * `@Roles` на `list`/`getOne`).
   *
   * Результат: обновлённая карточка заказа в `CALCULATION` с
   * созданными `WorkshopNeed`-строками. Ошибки расчёта /
   * валидации (отсутствует лекало/клиент/техкарта/размеры) приходят как
   * `ORDER_PATTERN_REQUIRED` / `ORDER_CLIENT_REQUIRED` /
   * `ORDER_TECH_CARD_REQUIRED` /
   * `ORDER_ITEMS_REQUIRED` (400), запуск из не-DRAFT —
   * `ORDER_INVALID_STATUS_TRANSITION` (409). См.
   * `apps/api/src/common/errors.ts`.
   */
  @Post(':id/start-calculation')
  startCalculation(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.orders.startCalculation(id, user.employeeId);
  }

  /**
   * Этап «Себестоимость заказа»: завершение расчёта.
   *
   * Из активных `WorkshopNeed` собираем `OrderCostEstimate` и
   * переводим заказ `CALCULATION → CALCULATION_DONE`. Тело —
   * `CompleteOrderCalculationSchema` (`usdRateRub` обязательно
   * только если в строках есть USD). RBAC — `ADMIN`/`SHOP_MANAGER`,
   * см. `@Roles('SHOP_MANAGER')` на классе.
   */
  @Post(':id/complete-calculation')
  completeCalculation(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CompleteOrderCalculationSchema))
    dto: CompleteOrderCalculationDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.costEstimates.completeCalculation(id, dto, user.employeeId);
  }

  /**
   * Этап «Себестоимость заказа»: вернуть заказ на пересчёт
   * (`CALCULATION_DONE → CALCULATION`). Активный
   * `OrderCostEstimate` помечается как `REVOKED`,
   * `WorkshopNeed`/`PurchaseOrder`/`PurchaseReceipt` не трогаются.
   */
  @Post(':id/reopen-calculation')
  reopenCalculation(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReopenOrderCalculationSchema))
    dto: ReopenOrderCalculationDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.costEstimates.reopenCalculation(id, dto, user.employeeId);
  }

  /**
   * Этап «Корректировка материалов после просчёта»: пересчитать
   * себестоимость БЕЗ смены статуса заказа. Текущий `COMPLETED`-расчёт
   * помечается `REVOKED`, создаётся новая версия из актуальных
   * `WorkshopNeed` + `OrderExtraCost`. Разрешено из `CALCULATION_DONE`
   * и `IN_PRODUCTION`. Тело — то же `CompleteOrderCalculationSchema`.
   */
  @Post(':id/recalculate-cost-estimate')
  recalculateCostEstimate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CompleteOrderCalculationSchema))
    dto: CompleteOrderCalculationDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.costEstimates.recalculateCostEstimate(id, dto, user.employeeId);
  }

  /**
   * Этап 2 «План операций на заказе» (см.
   * `docs/operation-time-norms-recon.md §11`,
   * `apps/api/src/modules/orders/order-operation-plan.service.ts`):
   * ручной пересчёт snapshot-полей плана операций
   * (`Order.operationCostPlanRub` / `operationTimePlanSec` / …).
   *
   * Сценарий: после создания заказа менеджер изменил у операции
   * ставку / норму времени / поразмерные ставки / шаги маршрута, и
   * snapshot заказа стал «устаревшим» (UI показывает badge
   * «Требует пересчёта»). Кнопка «Пересчитать план операций»
   * дёргает этот endpoint.
   *
   * RBAC: `ADMIN` / `SHOP_MANAGER` (наследуется от `@Roles` на
   * классе). Backend сам валидирует статус и пробрасывает
   * `OrderOperationPlanRecalculateNotAllowedException`
   * (409 `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`) для
   * `CALCULATION_DONE` / `IN_PRODUCTION` / `DONE` / `CANCELLED`
   * (см. `OrdersService.recalculateOperationPlan`).
   */
  @Post(':id/operation-plan/recalculate')
  recalculateOperationPlan(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.orders.recalculateOperationPlan(id, user.employeeId);
  }

  /**
   * Правка расценок / норм времени операций **в рамках заказа** (блок
   * «Операции» карточки заказа → «Редактировать маршрут заказа» →
   * «Сохранить всё»). Не трогает справочник `Operation` и шаблон
   * маршрута — переопределения живут только на снимке маршрута заказа
   * (`OrderRouteStep` / `OrderRouteStepSizeOverride`).
   *
   * RBAC: `ADMIN` / `SHOP_MANAGER` (наследуется от `@Roles` на классе).
   * Backend валидирует статус (нельзя у `DONE` / `CANCELLED`) и
   * принадлежность шагов/размеров заказу.
   */
  @Put(':id/route-overrides')
  updateRouteOverrides(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateOrderRouteOverridesSchema))
    dto: UpdateOrderRouteOverridesDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.orders.updateRouteOverrides(id, dto, user.employeeId);
  }

  /**
   * Плановая балансировка производственной цепочки заказа
   * (см. карточку заказа `/admin/orders/[id]`, блок «Производственная
   * цепочка»; `OrderProductionBalanceService.getForOrder`).
   *
   * Computed endpoint: ничего не пишет в БД, отдаёт DTO с построчной
   * рекомендацией количества людей на операцию, узким местом и
   * оценкой выпуска за смену. Это плановая рекомендация (не факт
   * работы сотрудников), payroll/Passport/OperationEntry/SalaryEntry/
   * OrderCostEstimate/WorkshopNeed не трогаются.
   *
   * Query (все поля опциональны):
   *   - `strategy`            — `LINE_BALANCE` (default) /
   *     `TARGET_SHIFT` / `TOTAL_WORKERS` / `TARGET_DURATION`;
   *   - `shiftSeconds`        — длина смены (default 28800);
   *   - `totalWorkers`        — включает стратегию `TOTAL_WORKERS`
   *     (имеет приоритет над `strategy`);
   *   - `targetDurationSec`   — включает стратегию `TARGET_DURATION`.
   * Если ничего не задано → стратегия `LINE_BALANCE` (балансировка
   * цепочки по текущему доступному штату).
   *
   * RBAC: `ADMIN` / `SHOP_MANAGER` (наследуется от `@Roles` на
   * классе). На MVP не открываем `SHOPFLOOR_MASTER` — это
   * управленческий срез, мастер цеха работает в `/shopfloor/*`.
   */
  @Get(':id/production-balance')
  getProductionBalance(
    @Param('id') id: string,
    @Query('strategy') strategy?: string,
    @Query('shiftSeconds') shiftSeconds?: string,
    @Query('totalWorkers') totalWorkers?: string,
    @Query('targetDurationSec') targetDurationSec?: string,
  ) {
    const options: OrderProductionBalanceQuery = {
      strategy: parseStrategy(strategy),
      shiftSeconds: parsePositiveQueryInt(shiftSeconds),
      totalWorkers: parsePositiveQueryInt(totalWorkers),
      targetDurationSec: parsePositiveQueryInt(targetDurationSec),
    };
    return this.productionBalance.getForOrder(id, options);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string) {
    return this.orders.complete(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.orders.cancel(id);
  }

  /**
   * Hard-delete отменённого заказа (этап «Удалить архивную запись
   * навсегда»). Доступно ADMIN/SHOP_MANAGER (class-level guard; ADMIN
   * проходит всегда). Сервис блокирует удаление, если заказ не
   * `CANCELLED` или по нему есть производственная история
   * (`ORDER_DELETE_FORBIDDEN`).
   */
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    return this.orders.remove(id, user.employeeId);
  }

  /**
   * MVP-3 (ADR-0022 §«Manual execution status»): ручной перевод
   * операционного статуса внешней потребности заказа.
   *
   * Стиль POST-action выбран сознательно — у нас уже есть
   * `start/complete/cancel` (POST), это однотипная action-ручка с
   * тем же RBAC (только SHOP_MANAGER/ADMIN). Через action разрешены
   * только переходы `PLANNED → ORDERED` и `ORDERED → RECEIVED`;
   * откатов и прямых правок `executionStatus` через PATCH
   * сознательно нет (см. ADR-0022).
   */
  @Post(':id/outsource-requirements/:requirementId/status')
  updateOutsourceRequirementStatus(
    @Param('id') id: string,
    @Param('requirementId') requirementId: string,
    @Body(new ZodValidationPipe(UpdateOrderOutsourceRequirementStatusSchema))
    dto: UpdateOrderOutsourceRequirementStatusDto,
  ) {
    return this.orders.updateOutsourceRequirementStatus(
      id,
      requirementId,
      dto.executionStatus,
    );
  }

  /**
   * Этап «Указать в заказе» (см. ТЗ §4): сохранить цвет конкретной
   * строки материала заказа. Доступно только для строк техкарты с
   * `colorRule = ORDER_SELECTED_COLOR` (snapshot-флаг
   * `requiresColorSelection = true`); для остальных backend
   * отвечает 409 `ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED`.
   *
   * RBAC: `ADMIN` / `SHOP_MANAGER` — наследуется от `@Roles` на классе.
   */
  @Patch(':id/material-requirements/:requirementId/color')
  updateMaterialRequirementColor(
    @Param('id') id: string,
    @Param('requirementId') requirementId: string,
    @Body(new ZodValidationPipe(UpdateOrderMaterialRequirementColorSchema))
    dto: UpdateOrderMaterialRequirementColorDto,
  ) {
    return this.orders.updateMaterialRequirementColor(
      id,
      requirementId,
      dto.selectedColorText,
    );
  }

  // -------------------------------------------------------------------------
  // Ручные строки логистики заказа (таблица «Операции» карточки заказа).
  // CRUD без переходов статусов: это собственные редактируемые данные
  // заказа, не snapshot. RBAC — `ADMIN`/`SHOP_MANAGER` (наследуется от
  // `@Roles` на классе).
  // -------------------------------------------------------------------------

  @Post(':id/logistics-lines')
  addLogisticsLine(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateOrderLogisticsLineSchema))
    dto: CreateOrderLogisticsLineDto,
  ) {
    return this.orders.addLogisticsLine(id, dto);
  }

  @Patch(':id/logistics-lines/:lineId')
  updateLogisticsLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(UpdateOrderLogisticsLineSchema))
    dto: UpdateOrderLogisticsLineDto,
  ) {
    return this.orders.updateLogisticsLine(id, lineId, dto);
  }

  @Delete(':id/logistics-lines/:lineId')
  deleteLogisticsLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ) {
    return this.orders.deleteLogisticsLine(id, lineId);
  }
}

/**
 * Узкий парсер числовых query-параметров эндпоинта
 * `/production-balance`. NestJS отдаёт `@Query()` как `string`, нам
 * достаточно положительного целого; всё остальное → `undefined`,
 * сервис сам подставит дефолты. Никаких 400 на «42abc» — UX/тесты
 * терпимы, неправильные значения тихо игнорируются.
 */
function parsePositiveQueryInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') return undefined;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.floor(num);
}

/**
 * Парсер `strategy` query-параметра. Принимает только литералы из
 * `PRODUCTION_BALANCE_STRATEGIES`; всё остальное → `undefined`,
 * сервис сам подставит дефолт `LINE_BALANCE`.
 */
function parseStrategy(
  raw: string | undefined,
): ProductionBalanceStrategy | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') return undefined;
  for (const s of PRODUCTION_BALANCE_STRATEGIES) {
    if (s === trimmed) return s;
  }
  return undefined;
}
