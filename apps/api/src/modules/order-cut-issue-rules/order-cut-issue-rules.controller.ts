import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  BulkUpsertOrderCutIssueRulesSchema,
  DisableOrderCutIssueRulesSchema,
  type BulkUpsertOrderCutIssueRulesDto,
  type DisableOrderCutIssueRulesDto,
  type OrderCutIssueRulesSummaryDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderCutIssueRulesService } from './order-cut-issue-rules.service.js';

/**
 * REST-контракт модуля «Очередь выдачи кроя по размерам».
 *
 * Маршруты идут под префиксом `/api/orders/:id/cut-issue-rules` —
 * это семантически принадлежит карточке заказа. На уровне класса
 * `@Roles` не ставим: GET доступен любой авторизованной роли,
 * write-эндпоинты закрыты явным `@Roles` на методе.
 *
 * С multi-queue: bulk-upsert принимает `queueIndex` в payload,
 * добавление новой очереди = bulk-upsert на свежий
 * `queueIndex = max + 1`. Отдельный «add empty queue» эндпоинт не
 * нужен — пустая очередь без строк ничего не блокирует, а UI
 * заводит первую строку сразу.
 *
 * Удаление пустой последней очереди —
 * `DELETE /api/orders/:id/cut-issue-rules/queues/:queueIndex` (см.
 * `OrderCutIssueRulesService.deleteQueue`).
 */
@Controller('orders/:id/cut-issue-rules')
export class OrderCutIssueRulesController {
  constructor(private readonly service: OrderCutIssueRulesService) {}

  @Get()
  list(@Param('id') orderId: string): Promise<OrderCutIssueRulesSummaryDto> {
    return this.service.listForOrder(orderId);
  }

  @Post()
  @Roles('SHOP_MANAGER', 'SHOPFLOOR_MASTER')
  bulkUpsert(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(BulkUpsertOrderCutIssueRulesSchema))
    dto: BulkUpsertOrderCutIssueRulesDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCutIssueRulesSummaryDto> {
    return this.service.bulkUpsert(user, orderId, dto);
  }

  @Post('disable-all')
  @Roles('SHOP_MANAGER', 'SHOPFLOOR_MASTER')
  disableAll(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(DisableOrderCutIssueRulesSchema))
    _dto: DisableOrderCutIssueRulesDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCutIssueRulesSummaryDto> {
    return this.service.disableAll(user, orderId);
  }

  /**
   * Удалить целиком одну очередь заказа. Разрешено только если
   * это последняя очередь и в ней `Σ issuedQty = 0` (см.
   * `OrderCutIssueRulesService.deleteQueue`). Без body.
   */
  @Delete('queues/:queueIndex')
  @Roles('SHOP_MANAGER', 'SHOPFLOOR_MASTER')
  deleteQueue(
    @Param('id') orderId: string,
    @Param('queueIndex') queueIndexParam: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCutIssueRulesSummaryDto> {
    const queueIndex = Number(queueIndexParam);
    if (!Number.isInteger(queueIndex) || queueIndex < 1) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_QUEUE_INDEX',
        message: 'Некорректный индекс очереди',
      });
    }
    return this.service.deleteQueue(user, orderId, queueIndex);
  }
}
