import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser, MachineScopes } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { EarningsService } from './earnings.service.js';

/**
 * Подресурс паспорта: список сдельных начислений по конкретному паспорту.
 *
 * Вынесен в EarningsModule, чтобы не размазывать работу с
 * `OperationEntry` по двум сервисам и не тащить `EarningsService` в
 * `PassportsModule` ради одного списочного метода (по аналогии с
 * `PassportDefectsController`).
 *
 * RBAC: `SHOP_MANAGER` / `ADMIN` видят все начисления по паспорту;
 * любая другая роль получает только свои подтверждённые строки
 * (`employeeId = self`, `status = APPROVED`). Если их нет — сервис
 * отдаёт пустой массив, не подсвечивая факт чужих начислений.
 * См. `docs/api.md §10`.
 */
@Controller('passports')
@MachineScopes('payroll:read')
export class PassportEarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get(':id/earnings')
  list(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.earnings.listByPassport(id, user);
  }
}
