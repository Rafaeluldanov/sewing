import { Module } from '@nestjs/common';
import { PrintersController } from './printers.controller.js';
import { PrintersAgentController } from './printers-agent.controller.js';
import { PrintJobsController } from './print-jobs.controller.js';
import { PrintersService } from './printers.service.js';
import { PrintJobsService } from './print-jobs.service.js';
import { AgentAuthGuard } from './agent.guard.js';

/**
 * MVP «Печать по рабочему месту через агент» (`docs/domain.md §17`).
 *
 * Контроллеры:
 *   - `PrintersController` — менеджерский CRUD принтеров и
 *     pairing-код (RBAC: SHOP_MANAGER/ADMIN).
 *   - `PrintersAgentController` — pair агента + heartbeat.
 *   - `PrintJobsController` — создание job-а сотрудником, polling
 *     агента, PATCH результата.
 */
@Module({
  controllers: [
    PrintersController,
    PrintersAgentController,
    PrintJobsController,
  ],
  providers: [PrintersService, PrintJobsService, AgentAuthGuard],
  exports: [PrintersService, PrintJobsService],
})
export class PrintersModule {}
