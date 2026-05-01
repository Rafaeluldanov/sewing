import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  CalculateWorkshopNeedsSchema,
  type CalculateWorkshopNeedsDto,
  type CalculateWorkshopNeedsResultDto,
  type WorkshopNeedListItemDto,
} from '@sewing/shared/workshop-needs';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { WorkshopNeedsService } from './workshop-needs.service.js';

/**
 * `/api/orders/:id/workshop-needs/*` — расчёт и чтение потребностей
 * конкретного заказа (см. `docs/recon-soft-integration.md §«Этап 4А»`).
 *
 *   POST  /api/orders/:id/workshop-needs/calculate  — расчёт
 *   GET   /api/orders/:id/workshop-needs            — список заказа
 *
 * Контроллер вынесен из `OrdersController` сознательно:
 *   - `OrdersController` имеет `@Roles('SHOP_MANAGER')` на классе и
 *     отдельную семантику CRUD-заказа; смешивать с workshop-needs
 *     неудобно;
 *   - все workshop-needs роуты живут в `WorkshopNeedsModule`, что
 *     упрощает читаемость и тестирование.
 *
 * RBAC: `ADMIN` / `SHOP_MANAGER` — новые роли не заводим.
 */
@Controller('orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class WorkshopNeedsOrderController {
  constructor(private readonly needs: WorkshopNeedsService) {}

  @Post(':id/workshop-needs/calculate')
  calculate(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CalculateWorkshopNeedsSchema))
    dto: CalculateWorkshopNeedsDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<CalculateWorkshopNeedsResultDto> {
    return this.needs.calculateForOrder(orderId, dto, user.employeeId);
  }

  @Get(':id/workshop-needs')
  listForOrder(
    @Param('id') orderId: string,
  ): Promise<WorkshopNeedListItemDto[]> {
    // Карточка конкретного заказа должна видеть свои потребности
    // независимо от того, идёт расчёт или уже завершён. Передаём
    // явный `orderCalculationStatus: 'ALL'` — backend default тоже
    // даст `ALL` при наличии `orderId`, но эксплицитно надёжнее.
    return this.needs.list({ orderId, orderCalculationStatus: 'ALL' });
  }
}
