import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreatePrinterSchema,
  UpdatePrinterSchema,
  type CreatePrinterDto,
  type PrinterDetailDto,
  type PrinterSummaryDto,
  type UpdatePrinterDto,
} from '@sewing/shared/printers';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Public, Roles } from '../auth/auth.decorators.js';
import { PrintersService } from './printers.service.js';

/**
 * Управление принтерами рабочих мест (см. `docs/api.md §16`,
 * `docs/screens.md §18`). Доступ — `SHOP_MANAGER`/`ADMIN`. Агентские
 * endpoint-ы вынесены в отдельный контроллер `PrintersAgentController`.
 */
@Controller('printers')
@Roles('SHOP_MANAGER', 'ADMIN')
export class PrintersController {
  private readonly logger = new Logger(PrintersController.name);

  constructor(private readonly printers: PrintersService) {}

  @Get()
  list(): Promise<PrinterSummaryDto[]> {
    return this.printers.list();
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<PrinterDetailDto> {
    return this.printers.getOne(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreatePrinterSchema)) dto: CreatePrinterDto,
  ): Promise<PrinterDetailDto> {
    return this.printers.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePrinterSchema)) dto: UpdatePrinterDto,
  ): Promise<PrinterDetailDto> {
    return this.printers.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.printers.remove(id);
  }

  /**
   * «Сгенерировать код подключения» — менеджер кликает кнопку,
   * сервер обновляет `pairingCode` принтера. Старый код — теряется,
   * как и должно быть: один активный код в каждый момент.
   */
  @Post(':id/pairing-code')
  generatePairingCode(@Param('id') id: string): Promise<PrinterDetailDto> {
    return this.printers.generatePairingCode(id);
  }

  /**
   * «Скачать агент» — отдаём собранный Windows-exe
   * (`apps/agent/dist/sewing-print-agent.exe`). Это self-contained
   * бинарник: оператор скачивает его на Windows-станцию и запускает
   * без установки Node.js. Сборка — `cd apps/agent && npm run build:win`
   * (см. `apps/agent/README.md`).
   *
   * Endpoint @Public, чтобы менеджер мог отправить ссылку оператору
   * без логина в админку. Никаких секретов в exe нет — только
   * клиентский код.
   */
  @Public()
  @Get('agent-download/sewing-print-agent.exe')
  @Header('content-type', 'application/octet-stream')
  @Header(
    'content-disposition',
    'attachment; filename="sewing-print-agent.exe"',
  )
  async downloadAgent(@Res() res: Response): Promise<void> {
    const found = this.resolveAgentBundlePath();
    if (!found) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'AGENT_BUNDLE_NOT_FOUND',
        message:
          'Сборка агента не найдена. Выполните `cd apps/agent && npm run build:win` ' +
          'и положите apps/agent/dist/sewing-print-agent.exe рядом с backend ' +
          '(либо раскатите через CD, либо задайте PRINT_AGENT_PATH).',
      });
    }
    const buf = await readFile(found);
    res.status(200).send(buf);
  }

  /**
   * Ищем `sewing-print-agent.exe` независимо от cwd процесса:
   *   1) `PRINT_AGENT_PATH` (env override) — для CD/нестандартных раскладок.
   *   2) Абсолютные пути относительно `__dirname` бандла webpack/ts-node —
   *      работает и для `nest build --webpack` (`apps/api/dist/main.js`),
   *      и для `nest start --watch` (`apps/api/src/...`).
   *   3) Пути относительно `process.cwd()` — на случай systemd/pm2/CI,
   *      где cwd может быть `/sewing` или `/sewing/apps/api`.
   *
   * Если ничего не нашли — пишем WARN со списком проверенных путей,
   * чтобы оператору было что показать в багрепорте, и возвращаем `null`
   * (контроллер превратит это в `AGENT_BUNDLE_NOT_FOUND`).
   */
  private resolveAgentBundlePath(): string | null {
    const envPath = process.env.PRINT_AGENT_PATH?.trim();
    const cwd = process.cwd();
    const candidates: string[] = [];

    if (envPath) {
      candidates.push(isAbsolute(envPath) ? envPath : resolve(cwd, envPath));
    }

    candidates.push(
      resolve(__dirname, '../../../agent/dist/sewing-print-agent.exe'),
      resolve(__dirname, '../../agent/dist/sewing-print-agent.exe'),
      resolve(__dirname, '../../../../../apps/agent/dist/sewing-print-agent.exe'),
      resolve(__dirname, '../../../../apps/agent/dist/sewing-print-agent.exe'),
      resolve(cwd, 'apps/agent/dist/sewing-print-agent.exe'),
      resolve(cwd, '../agent/dist/sewing-print-agent.exe'),
      resolve(cwd, '../../apps/agent/dist/sewing-print-agent.exe'),
      resolve(cwd, 'dist-agent/sewing-print-agent.exe'),
      resolve(cwd, 'sewing-print-agent.exe'),
    );

    const seen = new Set<string>();
    const unique = candidates.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });

    const found = unique.find((p) => existsSync(p));
    if (found) return found;

    this.logger.warn(
      `AGENT_BUNDLE_NOT_FOUND: cwd=${cwd} __dirname=${__dirname} ` +
        `PRINT_AGENT_PATH=${envPath ?? '(unset)'} ` +
        `checked=${JSON.stringify(unique)}`,
    );
    return null;
  }
}
