import { Controller, Get, Query } from '@nestjs/common';
import {
  ProductionBoardDrillQuerySchema,
  ProductionBoardQuerySchema,
  type ProductionBoardDrillQuery,
  type ProductionBoardDrillDto,
  type ProductionBoardDto,
  type ProductionBoardQuery,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { ProductionBoardService } from './production-board.service.js';

/**
 * «Доска движения тиража» — кабинет мастера (вкладка «Движение
 * тиража», `apps/web/app/master`).
 *
 *   GET /api/master/production-board?days=7|14|30
 *   GET /api/master/production-board/drill?cutDate&stage[&employeeId]
 *
 * RBAC: `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN` — тот же доступ,
 * что у экрана `/master` (`canSeeMasterPage`). Read-only: контроллер
 * не делает мутаций.
 */
@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')
@Controller('master/production-board')
export class ProductionBoardController {
  constructor(private readonly service: ProductionBoardService) {}

  @Get()
  board(
    @Query(new ZodValidationPipe(ProductionBoardQuerySchema))
    query: ProductionBoardQuery,
  ): Promise<ProductionBoardDto> {
    return this.service.getBoard(query);
  }

  @Get('drill')
  drill(
    @Query(new ZodValidationPipe(ProductionBoardDrillQuerySchema))
    query: ProductionBoardDrillQuery,
  ): Promise<ProductionBoardDrillDto> {
    return this.service.getDrill(query);
  }
}
