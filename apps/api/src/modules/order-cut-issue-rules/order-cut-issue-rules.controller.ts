import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
 * REST-контракт модуля «Очередь выдачи кроя по размерам» (см.
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `docs/api.md §«Очередь выдачи кроя»`,
 * `docs/order-flow.md §«Очередь выдачи кроя»`).
 *
 * Маршруты идут под префиксом `/api/orders/:id/cut-issue-rules` —
 * это семантически принадлежит карточке заказа, и UI карточки
 * (`apps/web/app/orders/[id]/page.tsx`) ходит сюда без отдельного
 * корневого ресурса. На уровне класса `@Roles` не ставим намеренно:
 * GET доступен любой авторизованной роли (нужно швеям/закройщикам
 * для диагностики «почему не выдаётся крой»), а write-эндпоинты
 * закрыты явным `@Roles` на методе (`getAllAndOverride` в
 * `RolesGuard` использует ближайший декоратор). `ADMIN` всегда
 * проходит через `RolesGuard`.
 */
@Controller('orders/:id/cut-issue-rules')
export class OrderCutIssueRulesController {
  constructor(private readonly service: OrderCutIssueRulesService) {}

  /**
   * Список строк очереди выдачи кроя для заказа + derived-сводка
   * (`status` ∈ `OFF` / `IN_PROGRESS` / `DONE`). Доступно любой
   * авторизованной роли — нужно как менеджеру (UI карточки заказа),
   * так и работникам цеха (диагностика на пилоте, support).
   */
  @Get()
  list(@Param('id') orderId: string): Promise<OrderCutIssueRulesSummaryDto> {
    return this.service.listForOrder(orderId);
  }

  /**
   * Bulk upsert одной формы карточки заказа: пришедшие строки
   * upsert-ятся (active = true), остальные активные строки заказа
   * деактивируются (`isActive = false`). См. JSDoc сервиса
   * (`bulkUpsert`) — там валидации и инварианты.
   */
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

  /**
   * Полностью отключить очередь выдачи кроя по заказу
   * (`isActive = false` для всех строк). Идемпотентно — повторный
   * вызов на «уже выключенной» очереди вернёт сводку без
   * дополнительной записи в audit.
   */
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
}
