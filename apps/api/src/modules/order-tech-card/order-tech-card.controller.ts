import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  CreateOrderTechCardLineSchema,
  CreateOrderTechCardLinesSchema,
  CreateOrderTechCardParameterSchema,
  SetOrderTechCardParameterValueSchema,
  UpdateOrderTechCardLineSchema,
  type CreateOrderTechCardLineDto,
  type CreateOrderTechCardLinesDto,
  type CreateOrderTechCardParameterDto,
  type OrderTechCardParametersDto,
  type SetOrderTechCardParameterValueDto,
  type UpdateOrderTechCardLineDto,
} from '@sewing/shared/order-tech-cards';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderTechCardService } from './order-tech-card.service.js';

/**
 * Параметры техкарты внутри заказа. Зеркало `OrderColorwaysController`:
 * все write-методы возвращают свежий полный DTO — единый источник для UI.
 */
@Controller('orders/:id/tech-card-parameters')
@MachineScopes('orders:read', 'orders:write')
export class OrderTechCardController {
  constructor(private readonly service: OrderTechCardService) {}

  @Get()
  list(@Param('id') orderId: string): Promise<OrderTechCardParametersDto> {
    return this.service.listForOrder(orderId);
  }

  /** Заполнить значение слота (пустая строка = очистить). */
  @Patch(':parameterId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  setValue(
    @Param('id') orderId: string,
    @Param('parameterId') parameterId: string,
    @Body(new ZodValidationPipe(SetOrderTechCardParameterValueSchema))
    dto: SetOrderTechCardParameterValueDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.setValue(orderId, parameterId, dto, user.employeeId);
  }

  /** Разовое копирование значения в остальные расцветки (не связь). */
  @Post(':parameterId/apply-to-all-variants')
  @Roles('ADMIN', 'SHOP_MANAGER')
  applyToAll(
    @Param('id') orderId: string,
    @Param('parameterId') parameterId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.applyToAllVariants(orderId, parameterId, user.employeeId);
  }

  /** Ad-hoc слот: нужен только в этом заказе, шаблон не трогаем. */
  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  createAdHoc(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CreateOrderTechCardParameterSchema))
    dto: CreateOrderTechCardParameterDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.createAdHoc(orderId, dto, user.employeeId);
  }

  @Delete(':parameterId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  removeAdHoc(
    @Param('id') orderId: string,
    @Param('parameterId') parameterId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.removeAdHoc(orderId, parameterId, user.employeeId);
  }
}

/**
 * Строки материала заказа: добавить свою, править и удалять ЛЮБУЮ (и
 * шаблонную, и ручную) — «техкарта живёт в заказе», шаблон только сеет
 * список (решение 16.07). Вернуть шаблонное состояние — «Обновить из
 * шаблона».
 *
 * Отдельный контроллер, потому что префикс другой: строки — не параметры.
 */
@Controller('orders/:id/tech-card/lines')
@MachineScopes('orders:read', 'orders:write')
export class OrderTechCardLinesController {
  constructor(private readonly service: OrderTechCardService) {}

  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  create(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CreateOrderTechCardLineSchema))
    dto: CreateOrderTechCardLineDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.createManualLine(orderId, dto, user.employeeId);
  }

  /**
   * Завести пачку строк одним заходом: одна транзакция и ОДНА пересборка
   * производных на всю пачку (по строке за запрос это было бы N пересборок
   * снимка, плана операций и потребностей цеха).
   */
  @Post('bulk')
  @Roles('ADMIN', 'SHOP_MANAGER')
  createMany(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CreateOrderTechCardLinesSchema))
    dto: CreateOrderTechCardLinesDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.createManualLines(orderId, dto, user.employeeId);
  }

  /** Правка полей строки (норма/ед./цвет/название/плотность). */
  @Patch(':requirementId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  update(
    @Param('id') orderId: string,
    @Param('requirementId') requirementId: string,
    @Body(new ZodValidationPipe(UpdateOrderTechCardLineSchema))
    dto: UpdateOrderTechCardLineDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.updateLine(orderId, requirementId, dto, user.employeeId);
  }

  @Delete(':requirementId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  remove(
    @Param('id') orderId: string,
    @Param('requirementId') requirementId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.service.removeLine(orderId, requirementId, user.employeeId);
  }
}
