import { Controller, Get, Query } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { MachineScopes } from '../auth/auth.decorators.js';

/**
 * «Найти в цехе»: заказ по паре «заказ покупателя ERP + лекало».
 *
 * ⛔ Зачем отдельная ручка. Отправка в цех делает ОДИН POST и второго не делает никогда: если
 * сосед не ответил, заказ мог создаться — повтор дал бы двойной тираж в раскрое. Поэтому после
 * молчания ERP не шлёт заказ заново, а СПРАШИВАЕТ: «мой заказ у тебя есть?». Есть — ERP
 * дописывает связь и живёт дальше; нет — снимает свою связь и отправляет заново.
 *
 * Ручка машинная (экрана у неё нет) и только читает.
 */
@Controller('integrations/erp-orders')
@MachineScopes('orders:read')
export class ErpOrderLookupController {
  constructor(private readonly prisma: PrismaService) {}

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
}
