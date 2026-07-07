import {
  Controller,
  Get,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ProductionCostV2QuerySchema,
  type ProductionCostV2Query,
} from '@sewing/shared/production-cost';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderProductionDocumentService } from './order-production-document.service.js';
import { ProductionCostV2Service } from './production-cost-v2.service.js';

/**
 * Контроллер управленческого отчёта «Себестоимость производства v2»
 * (см. `docs/production-cost-v2-recon.md`).
 *
 *   GET /api/admin/production-cost/v2
 *
 * Доступ: только `ADMIN` и `SHOP_MANAGER`. Это управленческий P&L
 * по лекалам / заказам / операциям / сотрудникам / размерам — никто
 * из исполнителей не должен видеть его в UI.
 *
 * Старый эндпоинт `GET /api/costs/production` (cell-фокус по дню
 * упаковки + простой) **остаётся как есть** — мы его не удаляем,
 * чтобы не сломать bookmarks и старые отчёты начальника цеха.
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('admin/production-cost')
export class ProductionCostV2Controller {
  constructor(
    private readonly service: ProductionCostV2Service,
    private readonly documentService: OrderProductionDocumentService,
  ) {}

  @Get('v2')
  getReport(
    @Query(new ZodValidationPipe(ProductionCostV2QuerySchema))
    query: ProductionCostV2Query,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.service.getReport(query);
  }

  /**
   * Справочники для выпадающих фильтров отчёта (лекало / заказ / клиент /
   * сотрудник / операция). Тот же RBAC, что и сам отчёт.
   */
  @Get('v2/filter-options')
  getFilterOptions(@CurrentUser() user: AuthPrincipal | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.service.getFilterOptions();
  }

  /**
   * Документ производства по одному заказу — план → факт построчно
   * (материалы + операции) с расхождениями и проваливанием по
   * размерам/цветам. Провал из вкладки «По заказам» отчёта.
   *
   *   GET /api/admin/production-cost/order/:orderId/document
   *
   * Тот же RBAC (`ADMIN`/`SHOP_MANAGER`), read-only.
   */
  @Get('order/:orderId/document')
  getOrderDocument(
    @Param('orderId') orderId: string,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.documentService.getDocument(orderId);
  }
}
