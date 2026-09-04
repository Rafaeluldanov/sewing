import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { MachineScopes } from '../auth/auth.decorators.js';
import { OrdersService } from '../orders/orders.service.js';

/**
 * «Найти в цехе»: заказ по паре «заказ покупателя ERP + лекало».
 *
 * ⛔ Зачем отдельная ручка. Отправка в цех делает ОДИН POST и второго не делает никогда: если
 * сосед не ответил, заказ мог создаться — повтор дал бы двойной тираж в раскрое. Поэтому после
 * молчания ERP не шлёт заказ заново, а СПРАШИВАЕТ: «мой заказ у тебя есть?». Есть — ERP
 * дописывает связь и живёт дальше; нет — снимает свою связь и отправляет заново.
 *
 * Рядом живёт «снять отправку»: отмена заказа цеха ПО КОМАНДЕ ERP. Человеку в цехе она закрыта
 * (§0.10) — он не знает ни о заказе покупателя, ни о его строках, которые после отмены надо
 * разблокировать; а без единственного пути отмены ошибочная отправка замуровывала бы обе стороны:
 * в ERP заказ с живой связью нельзя ни удалить, ни отменить.
 */
@Controller('integrations/erp-orders')
@MachineScopes('orders:read')
export class ErpOrderLookupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  @Get('lookup')
  async lookup(
    @Query('erp_customer_order_id') erpCustomerOrderId?: string,
    @Query('pattern_item_id') patternItemId?: string,
  ): Promise<{ found: boolean; order: Record<string, unknown> | null }> {
    if (!erpCustomerOrderId) return { found: false, order: null };
    const order = await this.prisma.order.findFirst({
      // Пара — потому что строки одного заказа покупателя разложены по лекалам, и у каждого
      // лекала свой заказ цеха. Без лекала в запросе нашёлся бы «какой-нибудь» из них.
      where: {
        erpCustomerOrderId,
        ...(patternItemId ? { patternItemId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        number: true,
        status: true,
        patternItemId: true,
        erpCustomerOrderNumber: true,
        createdAt: true,
      },
    });
    if (!order) return { found: false, order: null };
    return {
      found: true,
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        pattern_item_id: order.patternItemId,
        erp_customer_order_number: order.erpCustomerOrderNumber,
        created_at: order.createdAt.toISOString(),
      },
    };
  }

  /** Отменить заказ цеха по команде ERP — вместе со снятием связи на её стороне. */
  @Post(':id/cancel')
  @MachineScopes('orders:write')
  async cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string } = {},
  ): Promise<{ id: string; number: string; status: string }> {
    const order = await this.orders.cancel(id, { fromErp: true });
    if (body?.reason) {
      // Причина — в комментарий заказа: журнал цеха о заказе покупателя ничего не знает.
      await this.prisma.order.update({
        where: { id },
        data: {
          comment: [order.comment, `Отмена из ERP: ${body.reason}`]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000),
        },
      });
    }
    return { id: order.id, number: order.number, status: order.status };
  }
}
