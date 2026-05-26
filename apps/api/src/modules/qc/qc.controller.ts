import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CreatePassportDefectSchema,
  ListQcPassportsQuerySchema,
  type CreatePassportDefectDto,
  type ListQcPassportsQuery,
} from '@sewing/shared/qc';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { QcService } from './qc.service.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Контроллер ОТК. Маршруты см. `docs/api.md §8`.
 *
 * RBAC. Раздел /qc — рабочее место ОТК. Согласно матрице ролей
 * (см. `docs/api.md §1`, `docs/screens.md §1`) доступ есть только у:
 *   - `QC` — основная роль раздела;
 *   - `SHOP_MANAGER` — обзор и управление;
 *   - `ADMIN` — глобальный доступ через `RolesGuard`.
 *
 * Подресурс `/api/passports/:id/defects` (история дефектов) намеренно
 * вынесен в отдельный контроллер `PassportDefectsController` и оставлен
 * доступным любой авторизованной роли — он используется на универсальной
 * карточке паспорта `/passports/:id`, которую видят все сотрудники.
 */
@Controller('qc')
@Roles('QC', 'SHOP_MANAGER')
export class QcController {
  constructor(private readonly qc: QcService) {}

  @Get('passports')
  list(
    @Query(new ZodValidationPipe(ListQcPassportsQuerySchema))
    query: ListQcPassportsQuery,
  ) {
    return this.qc.listForQc(query);
  }

  @Get('passports/:id')
  getOne(@Param('id') id: string) {
    return this.qc.getQcDetail(id);
  }

  @Post('passports/:id/defects')
  recordDefect(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreatePassportDefectSchema))
    dto: CreatePassportDefectDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.qc.recordDefect(id, dto, user.employeeId);
  }

  /**
   * QC role-terminal: «Проверка выполнена».
   *
   * Тело пустое — актор берётся из сессии. Семантика и инварианты —
   * `QcService.completeQc` (см. также `docs/flows.md §F5`). RBAC
   * совпадает с другими `/api/qc/*` (QC, SHOP_MANAGER, +ADMIN), что
   * проверяется в `tests/integration/role-rbac.test.ts`.
   */
  @Post('passports/:id/complete')
  complete(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.qc.completeQc(id, user.employeeId);
  }

  /**
   * QC role-terminal: «Вернуть на переделку».
   *
   * Тело пустое — target-операция и швея-получатель определяются
   * сервером по последнему `OPERATION_FINISHED` паспорта (см.
   * `QcService.returnToRework`, `docs/flows.md §F5a`). RBAC такой же,
   * как у `complete` (QC, SHOP_MANAGER, +ADMIN через RolesGuard).
   */
  @Post('passports/:id/return-to-rework')
  returnToRework(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.qc.returnToRework(id, user.employeeId);
  }
}
