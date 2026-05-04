import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreatePrintJobDto,
  PrintJobDto,
  PrintJobSource,
  UpdatePrintJobStatusDto,
} from '@sewing/shared/printers';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ShiftSessionRequiredException } from '../../common/errors.js';
import {
  PrinterInactiveException,
  PrinterNotFoundException,
  PrintersService,
} from './printers.service.js';

/**
 * Сервис заданий на печать (`PrintJob`). Содержит:
 *   1. логику выбора принтера по активной смене сотрудника;
 *   2. сборку `payloadUrl` — мы НЕ дублируем рендер, а берём
 *      существующие endpoint-ы (`/api/passports/:id/print` и т.д.);
 *   3. поллинг агента (`pollForAgent`) и завершение job-а
 *      (`updateStatus`).
 *
 * См. `docs/domain.md §17`, `docs/api.md §16`.
 */
@Injectable()
export class PrintJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly printers: PrintersService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE (из системы — пользователь нажал «Печать»)
  // -------------------------------------------------------------------------

  async createForUser(
    employeeId: string,
    dto: CreatePrintJobDto,
    apiBaseUrl: string,
  ): Promise<PrintJobDto> {
    const printer = await this.resolvePrinter(employeeId, dto.printerId);
    if (!printer.isActive) throw new PrinterInactiveException();
    // Для TEST используем сам принтер как sourceId — payloadUrl
    // станет `/api/printers/<printerId>/test-page` (HTML, который
    // агент умеет печатать через Chrome/Edge). Раньше TEST мапился
    // на `/api/health` (JSON), и job всегда падал с
    // «Unsupported print file type: .json».
    const sourceId =
      dto.sourceType === 'TEST' ? dto.sourceId ?? printer.id : dto.sourceId;
    const payloadUrl = buildPayloadUrl(apiBaseUrl, dto.sourceType, sourceId);
    const created = await this.prisma.printJob.create({
      data: {
        printerId: printer.id,
        sourceType: dto.sourceType,
        sourceId: sourceId ?? null,
        payloadUrl,
        status: 'PENDING',
      },
    });
    return this.toDto(created, printer.selectedWindowsPrinter);
  }

  // -------------------------------------------------------------------------
  // CREATE BATCH (массовая печать — например, «все ячейки склада»)
  // -------------------------------------------------------------------------

  /**
   * Создаёт сразу N PENDING-job-ов на конкретный принтер. Используется
   * batch-операциями (например, `POST /api/warehouses/:id/print-cells`,
   * см. `docs/api.md §15`). Принтер выбран явно вызывающим кодом, без
   * привязки к смене сотрудника — это управленческая операция, а не
   * пользовательская кнопка «Печать».
   *
   * Все job-ы создаются одной транзакцией: если хоть один не ляжет,
   * мы не оставим в очереди «половину» задания. На MVP агент сам
   * сериализует печать (FIFO по `createdAt`).
   */
  async createBatch(
    printerId: string,
    items: Array<{ sourceType: PrintJobSource; sourceId?: string | null }>,
    apiBaseUrl: string,
  ): Promise<{ jobsCreated: number; selectedWindowsPrinter: string | null }> {
    if (items.length === 0) {
      return { jobsCreated: 0, selectedWindowsPrinter: null };
    }
    const printer = await this.prisma.printer.findUnique({
      where: { id: printerId },
    });
    if (!printer) throw new PrinterNotFoundException();
    if (!printer.isActive) throw new PrinterInactiveException();

    const data = items.map((it) => ({
      printerId: printer.id,
      sourceType: it.sourceType,
      sourceId: it.sourceId ?? null,
      payloadUrl: buildPayloadUrl(apiBaseUrl, it.sourceType, it.sourceId),
      status: 'PENDING' as const,
    }));

    const created = await this.prisma.printJob.createMany({ data });
    return {
      jobsCreated: created.count,
      selectedWindowsPrinter: printer.selectedWindowsPrinter,
    };
  }

  // -------------------------------------------------------------------------
  // LIST (для UI карточки принтера)
  // -------------------------------------------------------------------------

  async listForPrinter(
    printerId: string,
    limit = 20,
  ): Promise<PrintJobDto[]> {
    const printer = await this.prisma.printer.findUnique({
      where: { id: printerId },
      select: { selectedWindowsPrinter: true },
    });
    const rows = await this.prisma.printJob.findMany({
      where: { printerId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(100, limit)),
    });
    return rows.map((r) => this.toDto(r, printer?.selectedWindowsPrinter ?? null));
  }

  // -------------------------------------------------------------------------
  // AGENT POLLING
  // -------------------------------------------------------------------------

  /**
   * Агент опрашивает: «есть ли работа?». Возвращаем ОДНО задание (FIFO
   * по `createdAt`), и одновременно обновляем `lastSeenAt` принтера —
   * это и есть наш heartbeat. Состояние job-а пока не меняем: статус
   * перейдёт только при `updateStatus` от того же агента.
   *
   * Возвращаем массив, чтобы оставить простор для будущей пакетной
   * выдачи (несколько принтеров на агенте, бачи), но на MVP всегда
   * 0 или 1 элемент.
   */
  async pollForAgent(printerId: string): Promise<PrintJobDto[]> {
    const selectedWindowsPrinter = await this.printers.heartbeat(printerId);
    const job = await this.prisma.printJob.findFirst({
      where: { printerId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return job ? [this.toDto(job, selectedWindowsPrinter)] : [];
  }

  // -------------------------------------------------------------------------
  // AGENT UPDATE (PATCH PRINTED / FAILED)
  // -------------------------------------------------------------------------

  async updateStatus(
    printerId: string,
    jobId: string,
    dto: UpdatePrintJobStatusDto,
  ): Promise<PrintJobDto> {
    const job = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!job) throw new PrintJobNotFoundException();
    if (job.printerId !== printerId) throw new PrintJobNotFoundException();
    if (job.status !== 'PENDING') throw new PrintJobAlreadyClosedException();

    const updated = await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        status: dto.status,
        errorMessage: dto.status === 'FAILED' ? dto.errorMessage ?? null : null,
        completedAt: new Date(),
      },
    });
    const selectedWindowsPrinter = await this.printers.heartbeat(printerId);
    return this.toDto(updated, selectedWindowsPrinter);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Найти принтер для печати:
   *   1. если `printerId` передан явно (тестовая печать менеджером) —
   *      берём его;
   *   2. иначе — ищем активный принтер по РОЛИ сотрудника (новая
   *      привязка `Printer.role`, см. `docs/domain.md §17`);
   *   3. если по роли ничего нет — fallback на старую привязку:
   *      берём активную смену сотрудника и ищем принтер по
   *      `Printer.equipmentId === ShiftSession.equipmentId`. Это
   *      сохраняет работоспособность для инсталляций, которые ещё
   *      не переехали на роль-привязку. Удалить fallback можно
   *      одновременно с полем `Printer.equipmentId`.
   *
   * Если ни роль-привязка, ни смена не дают принтера —
   * `PRINTER_NOT_CONFIGURED_FOR_EMPLOYEE`. Если в fallback-ветке
   * нет смены — `SHIFT_SESSION_REQUIRED` (как раньше).
   */
  private async resolvePrinter(employeeId: string, printerId?: string) {
    if (printerId) {
      const explicit = await this.prisma.printer.findUnique({
        where: { id: printerId },
      });
      if (!explicit) throw new PrinterNotFoundException();
      return explicit;
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { role: true },
    });
    if (employee) {
      const byRole = await this.prisma.printer.findFirst({
        where: { role: employee.role, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      if (byRole) return byRole;
    }

    // Fallback: старая привязка по equipment активной смены.
    // Контракт ошибок намеренно НЕ изменён, чтобы не сломать
    // существующих клиентов и интеграционные тесты:
    // нет смены → SHIFT_SESSION_REQUIRED, нет принтера →
    // PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT.
    const shift = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      select: { equipmentId: true },
    });
    if (!shift) throw new ShiftSessionRequiredException();

    const printer = await this.prisma.printer.findFirst({
      where: { equipmentId: shift.equipmentId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!printer) throw new PrinterNotConfiguredException();
    return printer;
  }

  private toDto(
    row: Prisma.PrintJobGetPayload<{}>,
    selectedWindowsPrinter: string | null,
  ): PrintJobDto {
    return {
      id: row.id,
      printerId: row.printerId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      payloadUrl: row.payloadUrl,
      status: row.status,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      selectedWindowsPrinter,
    };
  }
}

// ---------------------------------------------------------------------------
// Местные исключения модуля
// ---------------------------------------------------------------------------

export class PrintJobNotFoundException extends NotFoundException {
  constructor() {
    super({
      statusCode: 404,
      code: 'PRINT_JOB_NOT_FOUND',
      message: 'Задание на печать не найдено',
    });
  }
}

export class PrintJobAlreadyClosedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'PRINT_JOB_ALREADY_CLOSED',
      message: 'Задание уже завершено',
    });
  }
}

export class PrinterNotConfiguredException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT',
      message:
        'Для этого рабочего места не настроен активный принтер. Откройте /admin/printers и привяжите принтер к оборудованию.',
    });
  }
}

// ---------------------------------------------------------------------------
// payloadUrl helpers
// ---------------------------------------------------------------------------

/**
 * Сборка абсолютного URL, по которому агент скачает payload для
 * печати. Маппинг — на существующие `@Public()`-эндпоинты:
 *
 *   PASSPORT_PRINT → /api/passports/:id/print  (HTML)
 *   PASSPORT_QR    → /api/passports/:id/qr     (PNG)
 *   BOX_LABEL      → /api/packing/boxes/:id/label (HTML)
 *   CELL_QR        → /api/cells/:id/qr         (PNG, голый QR)
 *   CELL_LABEL     → /api/cells/:id/print      (HTML, готовая 38×58 этикетка)
 *   TEST           → /api/printers/:id/test-page (HTML, тестовая
 *                    страница «связь до принтера работает», см.
 *                    `PrintersController.getTestPage`). На MVP
 *                    `sourceId` для TEST = printerId (подставляется
 *                    автоматически в `createForUser`).
 *                    Старый маппинг `/api/health` (JSON) ушёл, потому
 *                    что агент не умел такое печатать и job уходил
 *                    в FAILED со «Unsupported print file type: .json».
 */
export function buildPayloadUrl(
  apiBaseUrl: string,
  sourceType: PrintJobSource,
  sourceId?: string | null,
): string {
  const base = apiBaseUrl.replace(/\/+$/, '');
  switch (sourceType) {
    case 'PASSPORT_PRINT':
      assertSourceId(sourceType, sourceId);
      return `${base}/passports/${encodeURIComponent(sourceId!)}/print`;
    case 'PASSPORT_QR':
      assertSourceId(sourceType, sourceId);
      return `${base}/passports/${encodeURIComponent(sourceId!)}/qr`;
    case 'BOX_LABEL':
      assertSourceId(sourceType, sourceId);
      return `${base}/packing/boxes/${encodeURIComponent(sourceId!)}/label`;
    case 'CELL_QR':
      assertSourceId(sourceType, sourceId);
      return `${base}/cells/${encodeURIComponent(sourceId!)}/qr`;
    case 'CELL_LABEL':
      assertSourceId(sourceType, sourceId);
      return `${base}/cells/${encodeURIComponent(sourceId!)}/print`;
    case 'TEST':
      // `createForUser` подставит printerId как sourceId, если его
      // не было в DTO — ручной POST без sourceId в теории даст 409
      // PRINT_JOB_SOURCE_ID_REQUIRED, но в продовом UI кнопка
      // «Тестовая печать» всегда идёт через `createForUser`.
      assertSourceId(sourceType, sourceId);
      return `${base}/printers/${encodeURIComponent(sourceId!)}/test-page`;
    default: {
      const _exhaustive: never = sourceType;
      throw new Error(`Unknown sourceType: ${String(_exhaustive)}`);
    }
  }
}

function assertSourceId(sourceType: PrintJobSource, sourceId?: string | null) {
  if (!sourceId) {
    throw new ConflictException({
      statusCode: 409,
      code: 'PRINT_JOB_SOURCE_ID_REQUIRED',
      message: `Для типа ${sourceType} нужен sourceId`,
    });
  }
}
