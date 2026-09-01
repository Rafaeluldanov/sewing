import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  StartShiftSchema,
  StopShiftSchema,
  SwitchShiftOperationSchema,
  type StartShiftDto,
  type StopShiftDto,
  type SwitchShiftOperationDto,
} from '@sewing/shared/shifts';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ShiftsService } from './shifts.service.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * REST-контракт смены сотрудника.
 *
 * С MVP 1.1 (ADR-0014) `employeeId` берётся строго из сессии и из
 * тела/query запроса убран — клиент не может «открыть» смену чужому
 * сотруднику.
 */
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post('start')
  start(
    @Body(new ZodValidationPipe(StartShiftSchema)) dto: StartShiftDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.shifts.start({ ...dto, employeeId: user.employeeId });
  }

  @Post('stop')
  stop(
    @Body(new ZodValidationPipe(StopShiftSchema)) _dto: StopShiftDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.shifts.stop({ employeeId: user.employeeId });
  }

  /**
   * Переключить операцию в активной смене без stop/start. Подробности
   * и инварианты — `ShiftsService.switchOperation`.
   */
  @Post('switch-operation')
  switchOperation(
    @Body(new ZodValidationPipe(SwitchShiftOperationSchema))
    dto: SwitchShiftOperationDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.shifts.switchOperation({
      employeeId: user.employeeId,
      operationId: dto.operationId,
    });
  }

  @Get('current')
  current(@CurrentUser() user: AuthPrincipal) {
    return this.shifts.getCurrent(user.employeeId);
  }

  /**
   * Список кроев, закреплённых за текущим сотрудником прямо сейчас
   * (`Passport.currentEmployeeId = me AND status = IN_PROGRESS`).
   *
   * Используется на `/work` (швея, ВТО) для устойчивого блока
   * «Текущий крой» — после того, как пользователь подтвердил
   * «Принять» в модалке, ему всегда виден его рабочий контекст,
   * а не только короткий success-state.
   *
   * Backend сам вырезает по сессии — клиент не может запросить
   * чужой список (ADR-0014).
   */
  @Get('current-work')
  currentWork(@CurrentUser() user: AuthPrincipal) {
    return this.shifts.getCurrentWork(user.employeeId);
  }

  /**
   * Список паспортов, возвращённых ОТК на переделку этому сотруднику
   * (см. `ShiftsService.getMyReworkPassports`, `docs/flows.md §F5a`).
   * Используется на `/work` для секции «К переделке от ОТК». Backend
   * сам вырезает по сессии — клиент не может запросить чужой список
   * (ADR-0014).
   */
  @Get('my-rework')
  myRework(@CurrentUser() user: AuthPrincipal) {
    return this.shifts.getMyReworkPassports(user.employeeId);
  }

  /**
   * Паспорта с незакрытой операцией этого сотрудника, которые уже уехали
   * дальше по маршруту (см. `ShiftsService.getMyUnclosedPassports`).
   * Используется на `/work` для секции «Не закрыто вами». Backend сам
   * вырезает по сессии — чужой список запросить нельзя (ADR-0014).
   */
  @Get('my-unclosed')
  myUnclosed(@CurrentUser() user: AuthPrincipal) {
    return this.shifts.getMyUnclosedPassports(user.employeeId);
  }

  @Get('meta')
  meta() {
    return this.shifts.getMeta();
  }
}
