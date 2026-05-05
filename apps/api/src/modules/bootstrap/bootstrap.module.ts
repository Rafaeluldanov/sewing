import { Module } from '@nestjs/common';
import { ReferenceDataBootstrapService } from './reference-data.service.js';

/**
 * Системный bootstrap: гарантирует наличие референс-данных
 * (операции, размеры) при старте Nest.
 *
 * `PrismaModule` глобальный (`@Global()` в `prisma.module.ts`),
 * поэтому импортировать его здесь не требуется.
 *
 * Подробнее — `apps/api/src/modules/bootstrap/reference-data.ts`,
 * `reference-data.service.ts`.
 */
@Module({
  providers: [ReferenceDataBootstrapService],
})
export class BootstrapModule {}
