import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';

/**
 * Diagnostic consistency report (read-only).
 *
 * Назначение модуля — заранее увидеть «невозможные» состояния
 * производственной БД (паспорт IN_PROGRESS без сотрудника, две
 * активные смены на одного человека, отрицательное количество в
 * ячейке, …) до того, как они выстрелят в reporting / зарплате.
 *
 * Сервис делает только `findMany` / `groupBy` / `count` и НИЧЕГО не
 * пишет в БД — это сознательный инвариант (см. `docs/ops.md
 * §«Diagnostics»`). Никакого auto-fix.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService],
})
export class DiagnosticsModule {}
