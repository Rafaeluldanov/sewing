import { Controller, Get, Query } from '@nestjs/common';
import type { OrderCutIssueRuleBannerDto } from '@sewing/shared';
import { OrderCutIssueRulesService } from './order-cut-issue-rules.service.js';

/**
 * UI-эндпоинт для seamstress-баннера на /work «Сейчас сканируйте:
 * размер X, ячейки A-12, B-04 — осталось 5 шт». Отдельный
 * controller (а не часть `OrderCutIssueRulesController`), потому
 * что тот привязан к карточке конкретного заказа
 * (`/api/orders/:id/cut-issue-rules`), а здесь нужен срез по всем
 * заказам, применимым к текущей операции швеи.
 *
 * `operationId` приходит query-параметром: швея на /work читает
 * его из активной смены. Если operationId отсутствует или
 * операция не подходит ни под одну активную очередь — сервис
 * возвращает `applicable = false`, фронт прячет баннер.
 *
 * Доступ — любая авторизованная роль: подсказку видят и швеи, и
 * смежные роли (помощник раскройщика на буферных ячейках, мастер
 * цеха при диагностике). Никакого write-эффекта здесь нет.
 */
@Controller('cut-issue-banner')
export class CutIssueBannerController {
  constructor(private readonly service: OrderCutIssueRulesService) {}

  @Get()
  banner(
    @Query('operationId') operationId?: string,
  ): Promise<OrderCutIssueRuleBannerDto> {
    if (!operationId) {
      return Promise.resolve({ applicable: false, orders: [] });
    }
    return this.service.getActiveBannerForOperation(operationId);
  }
}
