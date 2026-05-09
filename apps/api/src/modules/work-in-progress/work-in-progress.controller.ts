import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  ListWorkInProgressBalancesQuerySchema,
  type ListWorkInProgressBalancesQuery,
} from './dto/list-work-in-progress-balances.dto.js';
import {
  ListWorkInProgressMovementsQuerySchema,
  type ListWorkInProgressMovementsQuery,
} from './dto/list-work-in-progress-movements.dto.js';
import { WorkInProgressService } from './work-in-progress.service.js';

/**
 * Read-only API foundation полуфабриката (см.
 * `apps/api/src/modules/work-in-progress/work-in-progress.service.ts`,
 * `prisma/schema.prisma::WorkInProgressBalance` /
 * `WorkInProgressMovement`).
 *
 *   GET /api/work-in-progress/balances  — текущие остатки кроя;
 *   GET /api/work-in-progress/movements — журнал движений (PLACE / ISSUE /
 *                                          RETURN / DELETE / PACK_OUT).
 *
 * **Отдельный контур** от материалов (`/api/stock/*`) и готовой
 * продукции (`/api/finished-goods/*`).
 *
 * Запись движений идёт неявно, в той же транзакции, что и
 * `Passport.place` / `issueToEmployee` / `delete`,
 * `MasterActionsService.returnToCell` / `setRouteStep` backward,
 * `PackingService.addPassport` (через
 * `WorkInProgressService.recordXxxInTx`-обёртки). Публичных мутаций
 * на этой итерации нет.
 *
 * RBAC: `@Roles('ADMIN', 'SHOP_MANAGER')`.
 */
@Controller('work-in-progress')
@Roles('ADMIN', 'SHOP_MANAGER')
export class WorkInProgressController {
  constructor(private readonly workInProgress: WorkInProgressService) {}

  @Get('balances')
  listBalances(
    @Query(new ZodValidationPipe(ListWorkInProgressBalancesQuerySchema))
    query: ListWorkInProgressBalancesQuery,
  ) {
    return this.workInProgress.listBalances(query);
  }

  @Get('movements')
  listMovements(
    @Query(new ZodValidationPipe(ListWorkInProgressMovementsQuerySchema))
    query: ListWorkInProgressMovementsQuery,
  ) {
    return this.workInProgress.listMovements(query);
  }
}
