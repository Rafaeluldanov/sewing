import { Module } from '@nestjs/common';
import { ConstructorTasksController } from './constructor-tasks.controller.js';
import { ConstructorTasksService } from './constructor-tasks.service.js';
import { ConstructorTasksStorageService } from './constructor-tasks-storage.service.js';

/**
 * «Заявка конструктору» (этап «Отправить изделие конструктору»).
 * См.:
 *   - `prisma/schema.prisma::ConstructorTask` и связанные модели;
 *   - `apps/web/app/admin/orders/new/create-product-inline.tsx`
 *     (вкладка `constructor` — модалка «Изделие»);
 *   - `apps/web/app/admin/constructor-tasks/*` — админский список/детали.
 *
 * Файлы вложений лежат в `apps/api/uploads/constructor-tasks/<taskId>/...`,
 * раздаются через `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`.
 *
 * Сервис экспортируется на случай, если другие модули (например,
 * будущий кабинет конструктора `ConstructorCabinetModule`) захотят
 * читать задачи.
 */
@Module({
  controllers: [ConstructorTasksController],
  providers: [ConstructorTasksService, ConstructorTasksStorageService],
  exports: [ConstructorTasksService],
})
export class ConstructorTasksModule {}
