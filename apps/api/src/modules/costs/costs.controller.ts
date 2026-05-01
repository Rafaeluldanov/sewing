import {
  Controller,
  Get,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ProductionCostQuerySchema,
  type ProductionCostQuery,
} from '@sewing/shared/costs';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CostsService } from './costs.service.js';

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
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  @Get('production')
  productionCost(
    @Query(new ZodValidationPipe(ProductionCostQuerySchema))
    query: ProductionCostQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.costs.getProductionCost(query);
  }
}
