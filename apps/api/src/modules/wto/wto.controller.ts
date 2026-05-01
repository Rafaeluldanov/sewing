import { Controller, Get, Param, Post } from '@nestjs/common';
import { WtoService } from './wto.service.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Контроллер ВТО (role-terminal `/wto`).
 *
 * RBAC. Раздел `/api/wto/*` — рабочее место ВТО. По матрице ролей
 * (см. `docs/api.md §1`, `docs/screens.md §10`) доступ есть только у:
 *   - `IRONING` — основная роль раздела;
 *   - `SHOP_MANAGER` — обзор и управление;
 *   - `ADMIN` — глобальный доступ через `RolesGuard`.
 *
 * Полностью повторяет архитектуру `QcController`: тонкий слой над
 * `WtoService`, тело запросов пустое (актор берётся из сессии).
 *
 * NB. «Принять паспорт на ВТО» = существующий `POST /api/passports/:id/scan`
 * (общий scan-driven вход на любую операцию). Backend сам делает
 * QC-gate (см. `PassportsService.scanOnOperation`), поэтому отдельного
 * `POST /api/wto/passports/:id/accept` не вводим — это лишний слой
 * с тем же поведением.
 */
@Controller('wto')
@Roles('IRONING', 'SHOP_MANAGER')
export class WtoController {
  constructor(private readonly wto: WtoService) {}

  @Get('passports/:id')
  getOne(@Param('id') id: string) {
    return this.wto.getWtoDetail(id);
  }

  /**
   * WTO role-terminal: «Завершить ВТО».
   *
   * Тело пустое — актор берётся из сессии. Семантика и инварианты —
   * `WtoService.completeWto` (см. также `docs/flows.md §F6`).
   */
  @Post('passports/:id/complete')
  complete(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.wto.completeWto(id, user.employeeId);
  }
}
