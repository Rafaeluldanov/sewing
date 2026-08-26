import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import {
  PayrollAccrualPreviewQuerySchema,
  UpdatePayrollAccrualScheduleSchema,
  type PayrollAccrualPreviewQuery,
  type UpdatePayrollAccrualScheduleDto,
} from '@sewing/shared/payroll-schedule';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PayrollScheduleService } from './payroll-schedule.service.js';

/**
 * Расписание начисления зарплаты (см. `docs/api.md`).
 *
 *   GET  /api/payroll/schedule          — настройка + ближайшие даты
 *   PUT  /api/payroll/schedule          — сохранить настройку
 *   GET  /api/payroll/schedule/preview  — что войдёт / что отложено
 *   POST /api/payroll/schedule/run-due  — создать черновик, если пора
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN`: настройка решает, попадут ли деньги
 * человека в ближайшую выплату, поэтому доступ тот же, что у ручной
 * правки начислений (`SALARY_MANAGER_ROLES`).
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('payroll/schedule')
export class PayrollScheduleController {
  constructor(private readonly schedule: PayrollScheduleService) {}

  @Get()
  get() {
    return this.schedule.get();
  }

  @Put()
  update(
    @Body(new ZodValidationPipe(UpdatePayrollAccrualScheduleSchema))
    body: UpdatePayrollAccrualScheduleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.schedule.update(body, user);
  }

  /**
   * Предпросмотр. Кроме даты принимает несохранённое правило
   * (`cutoffBasis`, `appliesToSewing`, `appliesToCutting`) — экран
   * «Правила начисления» считает по переключателю до сохранения.
   * Ничего не пишет, поэтому переданное правило живёт только в этом
   * ответе.
   */
  @Get('preview')
  preview(
    @Query(new ZodValidationPipe(PayrollAccrualPreviewQuerySchema))
    query: PayrollAccrualPreviewQuery,
  ) {
    return this.schedule.preview(query.accrualDate, {
      cutoffBasis: query.cutoffBasis,
      appliesToSewing: query.appliesToSewing,
      appliesToCutting: query.appliesToCutting,
    });
  }

  /**
   * Ленивый триггер автосоздания черновика: экран зарплаты дёргает его
   * при заходе. Возвращает id созданного документа или `null` — «не
   * пора / уже создан». Планировщика в проекте нет сознательно, см.
   * `PayrollScheduleService.ensureDueDraft`.
   */
  @Post('run-due')
  runDue(@CurrentUser() user: AuthPrincipal) {
    return this.schedule
      .ensureDueDraft(user)
      .then((documentId) => ({ documentId }));
  }
}
