import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CreatePrintJobSchema,
  UpdatePrintJobStatusSchema,
  type CreatePrintJobDto,
  type PrintJobDto,
  type UpdatePrintJobStatusDto,
} from '@sewing/shared/printers';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PrintJobsService } from './print-jobs.service.js';
import { AgentAuthGuard, CurrentPrinter } from './agent.guard.js';
import { resolvePublicApiBaseUrl } from './public-api-url.js';

/**
 * Контракт заданий на печать (`docs/api.md §16`).
 *
 *   POST /api/print-jobs
 *     — сотрудник нажал «Печать»; backend по активной смене
 *       находит принтер и создаёт PENDING job. См. flow в
 *       `docs/flows.md §F11`.
 *
 *   GET /api/print-jobs/agent
 *     — агент опрашивает свою очередь. Возвращает 0 или 1 job.
 *       Параллельно бьёт heartbeat.
 *
 *   PATCH /api/print-jobs/:id
 *     — агент сообщает результат (PRINTED/FAILED). Принтер
 *       идентифицируется по `X-Printer-Agent-Token`.
 *
 *   GET /api/print-jobs?printerId=…
 *     — менеджерский UI (карточка принтера) видит хвост job-ов.
 */
@Controller('print-jobs')
export class PrintJobsController {
  constructor(private readonly jobs: PrintJobsService) {}

  // -------------------------------------------------------------------------
  // USER FACING
  // -------------------------------------------------------------------------

  /**
   * Создаёт задание на печать для текущего сотрудника.
   *
   * Если в теле передан `printerId` — это «тестовая печать» из
   * карточки принтера (нужны роли `SHOP_MANAGER`/`ADMIN`,
   * валидируется ниже). Без `printerId` — обычная пользовательская
   * кнопка «Печать», доступна любой залогиненной роли.
   */
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreatePrintJobSchema)) dto: CreatePrintJobDto,
    @CurrentUser() user: AuthPrincipal,
    @Req() req: Request,
  ): Promise<PrintJobDto> {
    if (dto.printerId && !MANAGER_ROLES.has(user.role)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_ROLE',
        message:
          'Тестовая печать на конкретный принтер доступна только менеджерам.',
      });
    }
    const apiBaseUrl = resolvePublicApiBaseUrl(req);
    return this.jobs.createForUser(user.employeeId, dto, apiBaseUrl);
  }

  /**
   * Менеджерский просмотр очереди принтера. Только `SHOP_MANAGER`/
   * `ADMIN` (карточка принтера в `/admin/printers/:id`).
   */
  @Get()
  @Roles('SHOP_MANAGER', 'ADMIN')
  list(
    @Query('printerId') printerId: string,
    @Query('limit') limit?: string,
  ): Promise<PrintJobDto[]> {
    if (!printerId) return Promise.resolve([]);
    const n = limit ? Number(limit) : undefined;
    return this.jobs.listForPrinter(printerId, Number.isFinite(n) ? n! : 20);
  }

  // -------------------------------------------------------------------------
  // AGENT
  // -------------------------------------------------------------------------

  @Public()
  @UseGuards(AgentAuthGuard)
  @Get('agent')
  pollAgent(
    @CurrentPrinter() printer: { id: string },
  ): Promise<PrintJobDto[]> {
    return this.jobs.pollForAgent(printer.id);
  }

  @Public()
  @UseGuards(AgentAuthGuard)
  @Patch(':id')
  updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePrintJobStatusSchema))
    dto: UpdatePrintJobStatusDto,
    @CurrentPrinter() printer: { id: string },
  ): Promise<PrintJobDto> {
    return this.jobs.updateStatus(printer.id, id, dto);
  }
}

/** Роли, которые могут адресовать print-job на конкретный принтер вручную. */
const MANAGER_ROLES: ReadonlySet<string> = new Set(['SHOP_MANAGER', 'ADMIN']);
