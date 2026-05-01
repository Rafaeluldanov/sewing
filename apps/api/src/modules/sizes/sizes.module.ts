import { Module } from '@nestjs/common';
import { SizesController } from './sizes.controller.js';
import { SizesService } from './sizes.service.js';

/**
 * Модуль «Размеры» (этап «Создание пользовательского размера»).
 *
 * `GET /api/sizes` уже обслуживается `CatalogController` (read-only,
 * any role). Этот модуль добавляет **запись** в справочник
 * `Size`:
 *
 *   POST /api/sizes — создание нового размера в общем справочнике
 *                     (нормализация кода, idempotent-create).
 *
 * RBAC проверяется в контроллере (`@Roles('ADMIN', 'SHOP_MANAGER')`).
 * Никаких миграций / новых таблиц этап не вводит — пишем в
 * существующую `Size`.
 */
@Module({
  controllers: [SizesController],
  providers: [SizesService],
  exports: [SizesService],
})
export class SizesModule {}
