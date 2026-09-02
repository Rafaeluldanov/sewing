import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ProductionCostQuerySchema,
  type ProductionCostQuery,
} from '@sewing/shared/costs';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CostsService } from './costs.service.js';
import { PassportRealCostService } from './passport-real-cost.service.js';

/**
 * Контроллер модуля «Себестоимость выпуска» (`docs/api.md §17`).
 *
 *   GET /api/costs/production?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *
 * Доступ: только `SHOP_MANAGER` и `ADMIN`. Это управленческая
 * информация, ни один рабочий-исполнитель её не должен видеть в UI.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('costs')
@MachineScopes('costs:read')
export class CostsController {
  constructor(
    private readonly costs: CostsService,
    private readonly passportCost: PassportRealCostService,
  ) {}

  @Get('production')
  productionCost(
    @Query(new ZodValidationPipe(ProductionCostQuerySchema))
    query: ProductionCostQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.costs.getProductionCost(query);
  }

  /**
   * Фактическая себестоимость одного паспорта (материал + сдельная +
   * разнесённый оклад), с детализацией окладной части по операциям/людям.
   */
  @Get('passport/:id')
  passportCostBreakdown(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.passportCost.getForPassport(id);
  }

  /**
   * Финализация себестоимости за UTC-день (пишет `FINAL`-снимки по
   * упакованным паспортам). `?date=YYYY-MM-DD` — по умолчанию текущий
   * UTC-день. Запускается планировщиком после закрытия дня или вручную.
   */
  @Post('snapshots/finalize')
  finalizeSnapshots(
    @Query('date') date: string | undefined,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    const base =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00.000Z`)
        : new Date();
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth();
    const d = base.getUTCDate();
    const from = new Date(Date.UTC(y, m, d));
    const to = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
    return this.passportCost.finalizeDay(from, to);
  }
}
