import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

/**
 * Модуль «Поставщики» (Этап 5, см.
 * `docs/recon-soft-integration.md §«Этап 5»`).
 *
 * Управленческий справочник контрагентов и их закупочной номенклатуры.
 * Контракт REST — `suppliers.controller.ts`, бизнес-логика —
 * `suppliers.service.ts`. RBAC — `ADMIN`/`SHOP_MANAGER`, проверяется
 * в контроллере декоратором `@Roles(...)`.
 *
 * Связь с `WorkshopNeed` живёт в `WorkshopNeedsService.update`
 * (валидация существования + статуса). Сервис экспортируется, чтобы
 * `WorkshopNeedsModule` мог при необходимости валидировать
 * `Supplier`/`SupplierCatalogItem` напрямую (на MVP всё чтение идёт
 * через `PrismaService`, как и в других модулях).
 */
@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
