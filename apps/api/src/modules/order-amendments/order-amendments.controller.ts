import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  ApplyOperationAmendmentSchema,
  ApplyQuantityAmendmentSchema,
  ApplyRouteAmendmentSchema,
  ApplySizeAmendmentSchema,
  type AmendmentHistoryEntryDto,
  type ApplyOperationAmendmentDto,
  type ApplyQuantityAmendmentDto,
  type ApplyRouteAmendmentDto,
  type ApplySizeAmendmentDto,
  type OperationAmendmentResultDto,
  type OperationAmendmentStateDto,
  type QuantityAmendmentResultDto,
  type QuantityAmendmentStateDto,
  type RouteAmendmentResultDto,
  type SizeAmendmentResultDto,
  type SizeAmendmentStateDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderAmendmentsService } from './order-amendments.service.js';

/**
 * REST-контракт фичи «Правка заказа в производстве» под префиксом
 * `/api/orders/:id/amendments`. ФАЗА 1 — количество по размерам.
 *
 * GET открыт любой авторизованной роли (drawer читает состояние),
 * write — менеджерам заказа (`ADMIN` / `SHOP_MANAGER`), как у
 * `order-colorways` / `route-overrides`. Исключение — правка маршрута
 * (`PUT route`): к ней допущен ещё и `SHOPFLOOR_MASTER` (см. комментарий
 * у ручки).
 */
@Controller('orders/:id/amendments')
export class OrderAmendmentsController {
  constructor(private readonly service: OrderAmendmentsService) {}

  /** Состояние + ограничения правки количества (для drawer-а). */
  @Get('quantities')
  quantityState(
    @Param('id') orderId: string,
  ): Promise<QuantityAmendmentStateDto> {
    return this.service.getQuantityState(orderId);
  }

  /** Применить правку количества по размерам. */
  @Post('quantities')
  @Roles('ADMIN', 'SHOP_MANAGER')
  applyQuantity(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(ApplyQuantityAmendmentSchema))
    dto: ApplyQuantityAmendmentDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<QuantityAmendmentResultDto> {
    return this.service.applyQuantity(orderId, dto, user.employeeId);
  }

  /** Состояние + ограничения правки размерности (для drawer-а). */
  @Get('sizes')
  sizeState(@Param('id') orderId: string): Promise<SizeAmendmentStateDto> {
    return this.service.getSizeState(orderId);
  }

  /** Применить правку размерности (добавить / убрать размеры). */
  @Post('sizes')
  @Roles('ADMIN', 'SHOP_MANAGER')
  applySizes(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(ApplySizeAmendmentSchema))
    dto: ApplySizeAmendmentDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SizeAmendmentResultDto> {
    return this.service.applySizes(orderId, dto, user.employeeId);
  }

  /** Состояние + позиции вставки операции (для drawer-а). */
  @Get('operations')
  operationState(
    @Param('id') orderId: string,
  ): Promise<OperationAmendmentStateDto> {
    return this.service.getOperationState(orderId);
  }

  /** Добавить операцию в маршрут заказа (вставка впереди фронта). */
  @Post('operations')
  @Roles('ADMIN', 'SHOP_MANAGER')
  applyOperation(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(ApplyOperationAmendmentSchema))
    dto: ApplyOperationAmendmentDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OperationAmendmentResultDto> {
    return this.service.applyOperation(orderId, dto, user.employeeId);
  }

  /**
   * Применить правку маршрута целиком (вкладка «Маршрут»): состав,
   * порядок и параллельные группы впереди фронта производства. Тело —
   * ВЕСЬ целевой маршрут, дельту считает бэкенд.
   *
   * `SHOPFLOOR_MASTER` — единственная write-ручка модуля, открытая
   * мастеру цеха (вкладка «Заказы» в `/master`, см.
   * `apps/api/src/modules/master-orders/*`). Состав операций — его
   * зона: он первым видит, что в заказе не хватает ОТК или что
   * работу закрывают мимо маршрута. Количество, размерность и
   * расценки остаются у менеджера заказа — это план и деньги.
   */
  @Put('route')
  @Roles('ADMIN', 'SHOP_MANAGER', 'SHOPFLOOR_MASTER')
  applyRoute(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(ApplyRouteAmendmentSchema))
    dto: ApplyRouteAmendmentDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<RouteAmendmentResultDto> {
    return this.service.applyRoute(orderId, dto, user.employeeId);
  }

  /** Журнал правок заказа в производстве (read-only). */
  // Журнал правок тиража и размерности: ERP-заказы здесь править нельзя (§0.10), но по
  // собственным заказам цеха ERP должна видеть, почему тираж менялся.
  @MachineScopes('orders:read')
  @Get('history')
  history(
    @Param('id') orderId: string,
  ): Promise<AmendmentHistoryEntryDto[]> {
    return this.service.getHistory(orderId);
  }
}
