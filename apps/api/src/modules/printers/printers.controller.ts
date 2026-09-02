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
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Public, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PrintersService } from './printers.service.js';

/**
 * Управление принтерами рабочих мест (см. `docs/api.md §16`,
 * `docs/screens.md §18`). Доступ — `SHOP_MANAGER`/`ADMIN`. Агентские
 * endpoint-ы вынесены в отдельный контроллер `PrintersAgentController`.
 */
@Controller('printers')
@MachineScopes('printers:read')
@Roles('SHOP_MANAGER', 'ADMIN')
export class PrintersController {
  private readonly logger = new Logger(PrintersController.name);

  constructor(private readonly printers: PrintersService) {}

  /**
   * Массовые операции архива со списка `/admin/printers` (контракт —
   * `@sewing/shared/archive`): `isActive = false` → обратно → удалить
   * навсегда (только из архива). Архивный принтер не спаривается с
   * агентом; вместе с принтером уходит его очередь заданий печати.
   */
  @MachineScopes('printers:write')
  @Post('archive')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.printers.archiveMany(dto.ids, user.employeeId);
  }

  @MachineScopes('printers:write')
  @Post('restore')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.printers.restoreMany(dto.ids, user.employeeId);
  }

  @MachineScopes('printers:write')
  @Post('purge')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.printers.purgeMany(dto.ids, user.employeeId);
  }

  @Get()
  list(): Promise<PrinterSummaryDto[]> {
    return this.printers.list();
  }

  /**
   * Тестовая страница для агента. Возвращает простой A6-HTML с именем
   * принтера и текущим временем — это payload для job-ов с
   * `sourceType=TEST`. Public, потому что агент скачивает её без
   * куки/JWT (как и `/passports/:id/print`, `/cells/:id/print`).
   *
   * Раньше TEST мапился на `/api/health` (JSON), и агент честно
   * фейлил такие job-ы со «Unsupported print file type: .json». Это
   * запутывало менеджера: он жмёт «Тестовая печать», а ничего не
   * печатается. Сейчас отдаём настоящий HTML — Chrome/Edge печатают
   * его в обычном режиме `printHtmlWithBrowser`.
   *
   * ВАЖНО: route стоит ВЫШЕ `@Get(':id')`, иначе nest заматчит
   * `:id = 'test-page'` или наоборот — порядок объявления маршрутов
   * в Nest имеет значение для статики vs параметров.
   */
  @Public()
  @Get(':id/test-page')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async getTestPage(@Param('id') id: string): Promise<string> {
    const printer = await this.printers.getOne(id);
    return renderTestPageHtml(printer);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<PrinterDetailDto> {
    return this.printers.getOne(id);
  }

  @MachineScopes('printers:write')
  @Post()
  create(
    @Body(new ZodValidationPipe(CreatePrinterSchema)) dto: CreatePrinterDto,
  ): Promise<PrinterDetailDto> {
    return this.printers.create(dto);
  }

  @MachineScopes('printers:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePrinterSchema)) dto: UpdatePrinterDto,
  ): Promise<PrinterDetailDto> {
    return this.printers.update(id, dto);
  }

  @MachineScopes('printers:write')
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
  @MachineScopes('printers:write')
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

/**
 * Тестовая страница печати — намеренно плотный, безопасный к
 * парсингу chromium HTML, размер 80x80 mm (вписывается и в
 * термоэтикетку 58 mm, и в обычный A4). Включает имя принтера,
 * физический Windows-принтер (если уже выбран) и временной штамп —
 * по нему видно, что именно эта печать сработала.
 *
 * Никаких inline-скриптов: их потом всё равно подменит
 * `writeAutoPrintWrapper` в агенте (вставит свой `window.print()`).
 */
function renderTestPageHtml(printer: PrinterDetailDto): string {
  const escape = (s: string | null | undefined) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  const ts = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
  });
  // Намеренно НЕ задаём `@page { size: ... }` и не фиксируем ширину
  // в mm: размер бумаги/этикетки берётся из настроек физического
  // принтера в Windows (например TSC TE200 — заданный размер
  // термоэтикетки). Если задать здесь 80×80mm — на этикетке 100×150mm
  // содержимое поедет в угол, на A4 — будет крошечным куском в
  // верху листа. Так шаблон одинаково работает и на термопринтере,
  // и на офисном лазернике.
  //
  // Содержимое сделано максимально компактным (мелкий шрифт, узкие
  // отступы, минимум строк), чтобы влезло даже на самые мелкие
  // термоэтикетки 38×25 / 40×30 mm. Реальное масштабирование под
  // этикетку делает Chrome через `scalingType: 1` (FIT_TO_PAGE),
  // см. `apps/agent/src/windows-print.mjs`.
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Test print</title>
  <style>
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, "Segoe UI", Arial, sans-serif;
      color: #000;
      padding: 1mm 2mm;
      box-sizing: border-box;
      line-height: 1.15;
    }
    h1 { margin: 0 0 1mm 0; font-size: 9pt; }
    table { border-collapse: collapse; font-size: 7pt; }
    td { padding: 0 2mm 0 0; vertical-align: top; }
    .k { color: #555; }
    .v { font-weight: 600; word-break: break-word; }
    .muted { color: #555; font-size: 6pt; margin-top: 1mm; }
  </style>
</head>
<body>
  <h1>Тест печати</h1>
  <table>
    <tr><td class="k">Принтер</td><td class="v">${escape(printer.name)}</td></tr>
    <tr><td class="k">Windows</td><td class="v">${escape(printer.selectedWindowsPrinter ?? '(не выбран)')}</td></tr>
    <tr><td class="k">Хост</td><td class="v">${escape(printer.agentHostName ?? '(нет данных)')}</td></tr>
    <tr><td class="k">Время</td><td class="v">${escape(ts)}</td></tr>
  </table>
  <div class="muted">Связь Windows → принтер работает.</div>
</body>
</html>
`;
}
