import { Module } from '@nestjs/common';

import { CostsModule } from '../costs/costs.module.js';
import { ProductionDocumentNumberService } from './production-document-number.service.js';
import {
  OrderProductionDocumentController,
  ProductionDocumentsController,
} from './production-documents.controller.js';
import { ProductionDocumentsService } from './production-documents.service.js';

/**
 * Документы выпуска по заказам.
 *
 * `CostsModule` — ради `OrderFactCostService`: себестоимость считает движок цеха, второй расчёт
 * тех же денег разъехался бы с первым. Модуль экспортирует сервис, потому что документ рождается
 * НЕ здесь, а в транзакции закрытия заказа (`OrdersModule`) и дособирается на закрытии коробки
 * (`PackingModule`).
 */
@Module({
  imports: [CostsModule],
  controllers: [ProductionDocumentsController, OrderProductionDocumentController],
  providers: [ProductionDocumentsService, ProductionDocumentNumberService],
  exports: [ProductionDocumentsService],
})
export class ProductionDocumentsModule {}
