import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApplyOperationAmendmentSchema,
  ApplyQuantityAmendmentSchema,
  ApplySizeAmendmentSchema,
  type AmendmentHistoryEntryDto,
  type ApplyOperationAmendmentDto,
  type ApplyQuantityAmendmentDto,
  type ApplySizeAmendmentDto,
  type OperationAmendmentResultDto,
  type OperationAmendmentStateDto,
  type QuantityAmendmentResultDto,
  type QuantityAmendmentStateDto,
  type SizeAmendmentResultDto,
  type SizeAmendmentStateDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderAmendmentsService } from './order-amendments.service.js';

/**
 * REST-контракт фичи «Правка заказа в производстве» под префиксом
 * `/api/orders/:id/amendments`. ФАЗА 1 — количество по размерам.
 *
 * GET открыт любой авторизованной роли (drawer читает состояние),
 * write — менеджерам заказа (`ADMIN` / `SHOP_MANAGER`), как у
 * `order-colorways` / `route-overrides`.
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

  /** Журнал правок заказа в производстве (read-only). */
  @Get('history')
  history(
    @Param('id') orderId: string,
  ): Promise<AmendmentHistoryEntryDto[]> {
    return this.service.getHistory(orderId);
  }
}
