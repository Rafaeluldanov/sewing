import { Controller, Get } from '@nestjs/common';
import type { DiagnosticConsistencyReportDto } from '@sewing/shared/diagnostics';
import { Roles } from '../auth/auth.decorators.js';
import { DiagnosticsService } from './diagnostics.service.js';

/**
 * Контроллер read-only диагностики (см. `docs/ops.md §«Diagnostics»`).
 *
 *   GET /api/admin/diagnostics/consistency
 *
 * Доступ: `ADMIN` и `SHOP_MANAGER`. Никаких мутирующих endpoint-ов
 * в этом модуле быть не должно — это инвариант, продублированный в
 * smoke-тестах (`tests/smoke/diagnostics-admin.smoke.test.ts`).
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('admin/diagnostics')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get('consistency')
  consistency(): Promise<DiagnosticConsistencyReportDto> {
    return this.diagnostics.getConsistencyReport();
  }
}
