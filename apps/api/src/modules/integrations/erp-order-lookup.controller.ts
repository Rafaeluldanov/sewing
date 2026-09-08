import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ReplaceErpOrderPlanSchema,
  type ReplaceErpOrderPlanDto,
} from '@sewing/shared/orders';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
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

  /**
   * «Дослать»: ERP переписывает план СВОЕГО заказа цеха целиком.
   *
   * ⛔ Зачем ручка. Менеджер дописал в заказ покупателя строки по ТОМУ ЖЕ лекалу — второй заказ
   * цеха на то же лекало означал бы второй раскрой того же изделия. Человеку в цехе план
   * ERP-заказа закрыт (`ErpOrderPlanLockedException`), а ERP им как раз владеет: строки заказа
   * покупателя и есть план.
   *
   * ⛔ Приезжает ПОЛНАЯ картина, а не дельта: расцветки заменяются целиком тем же путём, что у
   * формы правки (`OrdersService.update` → `resyncColorwayDerived`), поэтому повтор запроса
   * безопасен — ERP шлёт его после молчания сети, не рискуя удвоить тираж.
   *
   * Окно — DRAFT / CALCULATION (гард `update`, 409 `ORDER_COLORWAYS_LOCKED`): после заморозки
   * плана ERP оформляет добор отдельным заказом.
   */
  @Patch(':id/plan')
  @MachineScopes('orders:write')
  async replacePlan(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplaceErpOrderPlanSchema))
    dto: ReplaceErpOrderPlanDto,
  ): Promise<{ id: string; number: string; status: string; qtyPlan: number }> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, erpCustomerOrderId: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    // Чужой заказ этой ручкой не правится: у собственного заказа цеха план ведёт цех, и ERP о
    // нём ничего не знает — переписать его её списком расцветок значило бы стереть чужую работу.
    if (!order.erpCustomerOrderId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_NOT_FROM_ERP',
        message:
          'Это собственный заказ цеха — его план ведёт цех, из ERP он не переписывается',
      });
    }
    const updated = await this.orders.update(id, { variants: dto.variants }, null, {
      fromErp: true,
    });
    return {
      id: updated.id,
      number: updated.number,
      status: updated.status,
      qtyPlan: updated.items.reduce((sum, i) => sum + i.qtyPlan, 0),
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
