import { Controller, Get, Param, Query } from '@nestjs/common';

import { Roles } from '../auth/auth.decorators.js';
import { ProductionDocumentsService } from './production-documents.service.js';

/**
 * Документы выпуска: список и карточка.
 *
 * ⛔ Ручки только на ЧТЕНИЕ. Документ собирается сам из фактов производства — писать в него
 * снаружи нечем и незачем: любое «исправление» здесь было бы расхождением с цехом.
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('admin/production-documents')
export class ProductionDocumentsController {
  constructor(private readonly documents: ProductionDocumentsService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const toInt = (v?: string): number | undefined => {
      const parsed = v == null ? NaN : Number(v);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    return this.documents.list({
      status,
      search,
      page: toInt(page),
      pageSize: toInt(pageSize),
    });
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return this.documents.getOne(id);
  }
}

/**
 * Документ выпуска ЗАКАЗА — для блока в карточке заказа.
 *
 * Отдельный контроллер, а не метод выше: адрес принадлежит заказу (`/admin/orders/:orderId/...`),
 * и один `@Controller` на файл — правило репозитория (`docs:check` иначе ловит дрейф).
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('admin/orders')
export class OrderProductionDocumentController {
  constructor(private readonly documents: ProductionDocumentsService) {}

  /** `null`, если заказ ещё не закрыт: документ рождается закрытием. */
  @Get(':orderId/production-document')
  async forOrder(@Param('orderId') orderId: string) {
    return this.documents.forOrder(orderId);
  }
}
