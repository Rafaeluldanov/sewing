import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  AgentPairSchema,
  AgentSelectWindowsPrinterSchema,
  AgentWindowsPrintersSchema,
  type AgentPairDto,
  type AgentPairResultDto,
  type AgentSelectWindowsPrinterDto,
  type AgentSelectWindowsPrinterResultDto,
  type AgentWindowsPrintersDto,
  type AgentWindowsPrintersResultDto,
} from '@sewing/shared/printers';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorators.js';
import { PrintersService } from './printers.service.js';
import { AgentAuthGuard, CurrentPrinter } from './agent.guard.js';

/**
 * Агентские endpoint-ы для рабочих мест (см. `docs/api.md §16`).
 *
 *   POST /api/printers/agent/pair
 *     - @Public, авторизация по pairingCode из тела;
 *     - меняет код на `printerId + agentToken`.
 *
 *   POST /api/printers/agent/heartbeat
 *     - @Public для AuthGuard, защищён `AgentAuthGuard`-ом;
 *     - агент периодически бьёт «я жив», даже если нет job-ов.
 *
 *   POST /api/printers/agent/windows-printers
 *     - @Public для AuthGuard, защищён `AgentAuthGuard`-ом;
 *     - агент шлёт `hostName` Windows-станции и список её системных
 *       принтеров (`Get-Printer | Select Name`). Сервер сохраняет
 *       их в `Printer.availableWindowsPrinters` и `agentHostName`,
 *       чтобы менеджер мог выбрать конкретный физический принтер
 *       в `/admin/printers/:id`. Возвращает текущий
 *       `selectedWindowsPrinter` — чтобы агент сразу знал, куда
 *       печатать.
 *
 * См. `apps/agent` — клиентская реализация.
 */
@Controller('printers/agent')
export class PrintersAgentController {
  constructor(private readonly printers: PrintersService) {}

  @Public()
  @Post('pair')
  pair(
    @Body(new ZodValidationPipe(AgentPairSchema)) dto: AgentPairDto,
  ): Promise<AgentPairResultDto> {
    return this.printers.pairAgent(dto.pairingCode);
  }

  @Public()
  @UseGuards(AgentAuthGuard)
  @Post('heartbeat')
  async heartbeat(
    @CurrentPrinter() printer: { id: string },
  ): Promise<{ ok: true; selectedWindowsPrinter: string | null }> {
    const selectedWindowsPrinter = await this.printers.heartbeat(printer.id);
    return { ok: true, selectedWindowsPrinter };
  }

  @Public()
  @UseGuards(AgentAuthGuard)
  @Post('windows-printers')
  windowsPrinters(
    @Body(new ZodValidationPipe(AgentWindowsPrintersSchema))
    dto: AgentWindowsPrintersDto,
    @CurrentPrinter() printer: { id: string },
  ): Promise<AgentWindowsPrintersResultDto> {
    return this.printers.updateWindowsPrinters(printer.id, dto);
  }

  /**
   * `POST /api/printers/agent/select-windows-printer` — оператор сам
   * выбирает физический Windows-принтер прямо из агентского wizard-а
   * при первом запуске exe (см. `apps/agent/src/wizard.mjs`). До
   * этого выбор делал только менеджер в UI `/admin/printers/:id`.
   *
   * Защищено `AgentAuthGuard`-ом — менять можно только «свой» принтер
   * (`printerId` берётся из `X-Printer-Agent-Token`, тело лишь
   * передаёт имя). Имя должно лежать в `availableWindowsPrinters`,
   * иначе 422 `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`.
   */
  @Public()
  @UseGuards(AgentAuthGuard)
  @Post('select-windows-printer')
  selectWindowsPrinter(
    @Body(new ZodValidationPipe(AgentSelectWindowsPrinterSchema))
    dto: AgentSelectWindowsPrinterDto,
    @CurrentPrinter() printer: { id: string },
  ): Promise<AgentSelectWindowsPrinterResultDto> {
    return this.printers.selectWindowsPrinterByAgent(printer.id, dto.name);
  }
}
