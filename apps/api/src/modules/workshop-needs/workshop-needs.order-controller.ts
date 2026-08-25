import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CalculateWorkshopNeedsSchema,
  CreateManualWorkshopNeedSchema,
  type AcceptCalculatedWorkshopNeedsResultDto,
  type CalculateWorkshopNeedsDto,
  type CalculateWorkshopNeedsResultDto,
  type CreateManualWorkshopNeedDto,
  type WorkshopNeedDto,
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

  /**
   * Этап «Корректировка материалов после просчёта»: ручное добавление
   * строки потребности (непредвиденный расход материала). Разрешено в
   * `CALCULATION` / `CALCULATION_DONE` / `IN_PRODUCTION`.
   */
  @Post(':id/workshop-needs/manual')
  createManual(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CreateManualWorkshopNeedSchema))
    dto: CreateManualWorkshopNeedDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    return this.needs.createManual(orderId, dto, user.employeeId);
  }

  /**
   * Экран «Согласование закупки»: bulk «Принять теорию для
   * непроверенных». Все `CALCULATED`-строки заказа получают
   * `purchaseQty := purchaseQty ?? calculatedQty` + `status = REVIEWED`
   * (см. `WorkshopNeedsService.acceptCalculatedForOrder`).
   */
  @Post(':id/workshop-needs/accept-calculated')
  acceptCalculated(
    @Param('id') orderId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<AcceptCalculatedWorkshopNeedsResultDto> {
    return this.needs.acceptCalculatedForOrder(orderId, user.employeeId);
  }

  /**
   * Удаление ручной строки потребности. Системные snapshot-строки
   * удалять нельзя (409 `WORKSHOP_NEED_NOT_MANUAL`) — их гасят `cancel`.
   */
  @Delete(':id/workshop-needs/:needId')
  @HttpCode(204)
  async deleteManual(
    @Param('needId') needId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    await this.needs.deleteManual(needId, user.employeeId);
  }

  @Get(':id/workshop-needs')
  listForOrder(
    @Param('id') orderId: string,
    @Query('calculationScope') calculationScope?: string,
  ): Promise<WorkshopNeedListItemDto[]> {
    // Карточка конкретного заказа должна видеть свои потребности
    // независимо от того, идёт расчёт или уже завершён. Передаём
    // явный `orderCalculationStatus: 'ALL'` — backend default тоже
    // даст `ALL` при наличии `orderId`, но эксплицитно надёжнее.
    //
    // Фича «Варианты просчёта»: default `calculationScope=ACTIVE` —
    // только активный вариант, иначе двойной счёт. Вкладка «Потребности»
    // явно просит `ALL` и показывает все варианты с группировкой.
    //
    // `TIRAGE` — то же самое плюс без строк сигнального образца. Его просят
    // читатели денег и материалов тиража («Сводно», «Материалы», карточка
    // плановой себестоимости): образец считается на 1 изделие и в тиражной
    // таблице выглядит вторым комплектом тех же материалов. Выдачам и блоку
    // «Потребность цеха» образец, наоборот, нужен — они остаются на `ACTIVE`.
    const scope =
      calculationScope === 'ALL'
        ? 'ALL'
        : calculationScope === 'TIRAGE'
          ? 'TIRAGE'
          : 'ACTIVE';
    return this.needs.list({
      orderId,
      orderCalculationStatus: 'ALL',
      calculationScope: scope,
    });
  }
}
