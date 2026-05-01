import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateOrderSchema,
  ListOrdersQuerySchema,
  UpdateOrderSchema,
  type CreateOrderDto,
  type ListOrdersQuery,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OrdersService } from './orders.service.js';
import { Roles } from '../auth/auth.decorators.js';

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
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
  ) {
    return this.orders.create(dto);
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
  ) {
    return this.orders.update(id, dto);
  }

  @Post(':id/start')
  start(@Param('id') id: string) {
    return this.orders.start(id);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string) {
    return this.orders.complete(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.orders.cancel(id);
  }
}
