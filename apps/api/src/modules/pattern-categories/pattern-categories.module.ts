import { Module } from '@nestjs/common';
import { PatternCategoriesController } from './pattern-categories.controller.js';
import { PatternCategoriesService } from './pattern-categories.service.js';
import { PatternCategoriesStorageService } from './pattern-categories-storage.service.js';

/**
 * Модуль «Категории номенклатуры» (этап «Категории номенклатуры»).
 *
 * Контракт — `pattern-categories.controller.ts`, бизнес-логика —
 * `pattern-categories.service.ts`. RBAC — `ADMIN`/`SHOP_MANAGER`,
 * проверяется в контроллере.
 *
 * Модуль не зависит от `OrdersModule` / `WorkshopNeedsModule` /
 * `PatternsModule` — это самостоятельный справочник. Связь с
 * `PatternsService` осуществляется по `categoryId` (FK на стороне
 * `PatternItem`), валидация при сохранении площадей материалов
 * происходит внутри `PatternsService.replaceMaterialAreas` через
 * прямой запрос к БД (без зависимости от этого модуля).
 */
@Module({
  controllers: [PatternCategoriesController],
  providers: [PatternCategoriesService, PatternCategoriesStorageService],
  exports: [PatternCategoriesService],
})
export class PatternCategoriesModule {}
