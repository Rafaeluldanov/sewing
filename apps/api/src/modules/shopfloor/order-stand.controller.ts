import { Controller, Get, Param } from '@nestjs/common';
import type { OrderStandDto } from '@sewing/shared/order-stand';
import { OrderStandService } from './order-stand.service.js';

/**
 * `GET /api/orders/:id/stand` — «Схема стенда» по заказу: буква «П» из
 * шагов маршрута заказа с QR рабочих мест, стеллаж (ячейки) и паспорта
 * с текущим положением. См. `docs/api.md §11a`, `docs/screens.md §7.7`,
 * `@sewing/shared/order-stand`.
 *
 * Подресурс заказа, но живёт в shopfloor-модуле: это та же read-only
 * проекция цеха, что и `/shopfloor/display`, только по одному заказу
 * (та же `bucketOf`). RBAC — как у `/shopfloor/*`: любой вошедший
 * сотрудник; секретов в ответе нет (QR-payload'ы — штатные форматы
 * ADR-0008, которые и так напечатаны на этикетках).
 */
@Controller('orders')
export class OrderStandController {
  constructor(private readonly stand: OrderStandService) {}

  @Get(':id/stand')
  get(@Param('id') id: string): Promise<OrderStandDto> {
    return this.stand.getForOrder(id);
  }
}
