import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  AgentPairResultDto,
  AgentSelectWindowsPrinterResultDto,
  AgentWindowsPrintersDto,
  AgentWindowsPrintersResultDto,
  CreatePrinterDto,
  PrinterDetailDto,
  PrinterSummaryDto,
  UpdatePrinterDto,
} from '@sewing/shared/printers';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EquipmentNotFoundException } from '../../common/errors.js';

/**
 * Управление принтерами рабочих мест и pair-ом агентов.
 *
 * Простая модель MVP:
 *   - менеджер создаёт принтер, привязывает к `Equipment`;
 *   - жмёт «Сгенерировать код» → `pairingCode` обновляется;
 *   - агент при первом запуске обменивает `pairingCode` на
 *     постоянный `agentToken` + `printerId` (`pair`);
 *   - `pairingCode` после этого очищается, чтобы случайно не
 *     использовать дважды.
 *
 * См. `docs/domain.md §17`, `docs/api.md §16`.
 */
@Injectable()
export class PrintersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Сколько секунд heartbeat-а считаем «онлайн» в UI/derived-флаге. */
  private readonly ONLINE_TTL_MS = 60 * 1000;

  // -------------------------------------------------------------------------
  // LIST / GET
  // -------------------------------------------------------------------------

  async list(): Promise<PrinterSummaryDto[]> {
    const rows = await this.prisma.printer.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        equipment: { select: { id: true, name: true, code: true } },
        _count: { select: { jobs: { where: { status: 'PENDING' } } } },
      },
    });
    const now = Date.now();
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      isActive: p.isActive,
      isOnline: this.isOnline(p.isOnline, p.lastSeenAt, now),
      lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
      role: (p.role ?? null) as PrinterSummaryDto['role'],
      equipmentId: p.equipmentId,
      equipmentName: p.equipment?.name ?? null,
      equipmentCode: p.equipment?.code ?? null,
      hasPairingCode: !!p.pairingCode,
      pendingJobsCount: p._count.jobs,
    }));
  }

  async getOne(id: string): Promise<PrinterDetailDto> {
    const row = await this.prisma.printer.findUnique({
      where: { id },
      include: { equipment: { select: { id: true, name: true, code: true } } },
    });
    if (!row) throw new PrinterNotFoundException();
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      isActive: row.isActive,
      isOnline: this.isOnline(row.isOnline, row.lastSeenAt, Date.now()),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      role: (row.role ?? null) as PrinterDetailDto['role'],
      equipmentId: row.equipmentId,
      equipmentName: row.equipment?.name ?? null,
      equipmentCode: row.equipment?.code ?? null,
      pairingCode: row.pairingCode,
      createdAt: row.createdAt.toISOString(),
      agentHostName: row.agentHostName,
      availableWindowsPrinters: row.availableWindowsPrinters,
      windowsPrintersUpdatedAt: row.windowsPrintersUpdatedAt
        ? row.windowsPrintersUpdatedAt.toISOString()
        : null,
      selectedWindowsPrinter: row.selectedWindowsPrinter,
    };
  }

  // -------------------------------------------------------------------------
  // CREATE / UPDATE
  // -------------------------------------------------------------------------

  async create(dto: CreatePrinterDto): Promise<PrinterDetailDto> {
    if (dto.equipmentId) await this.assertEquipmentExists(dto.equipmentId);
    const created = await this.prisma.printer.create({
      data: {
        name: dto.name,
        type: dto.type ?? 'DEFAULT',
        // Новая привязка по роли (см. `Printer.role` в schema.prisma).
        // Старая `equipmentId` остаётся для обратной совместимости —
        // backend принимает оба поля независимо.
        role: dto.role ?? null,
        equipmentId: dto.equipmentId ?? null,
        isActive: dto.isActive ?? true,
      },
    });
    return this.getOne(created.id);
  }

  async update(id: string, dto: UpdatePrinterDto): Promise<PrinterDetailDto> {
    const existing = await this.prisma.printer.findUnique({ where: { id } });
    if (!existing) throw new PrinterNotFoundException();
    if (dto.equipmentId) await this.assertEquipmentExists(dto.equipmentId);

    if (
      dto.selectedWindowsPrinter !== undefined &&
      dto.selectedWindowsPrinter !== null
    ) {
      const allowed = existing.availableWindowsPrinters ?? [];
      if (!allowed.includes(dto.selectedWindowsPrinter)) {
        throw new WindowsPrinterNotFoundForAgentException(
          dto.selectedWindowsPrinter,
        );
      }
    }

    const data: Prisma.PrinterUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.role !== undefined) {
      // Прямое присвоение enum-поля: `null` снимает привязку, иначе —
      // конкретная роль. Валидация значения уже сделана Zod-схемой
      // (UpdatePrinterSchema.role), здесь дополнительной проверки
      // не нужно.
      data.role = dto.role;
    }
    if (dto.equipmentId !== undefined) {
      data.equipment = dto.equipmentId
        ? { connect: { id: dto.equipmentId } }
        : { disconnect: true };
    }
    if (dto.selectedWindowsPrinter !== undefined) {
      data.selectedWindowsPrinter = dto.selectedWindowsPrinter;
    }

    await this.prisma.printer.update({ where: { id }, data });
    return this.getOne(id);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.printer.findUnique({ where: { id } });
    if (!existing) throw new PrinterNotFoundException();
    await this.prisma.printer.delete({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // PAIRING
  // -------------------------------------------------------------------------

  /**
   * «Сгенерировать код» — менеджер кликает кнопку, мы выдаём
   * человекочитаемый pairingCode. Идемпотентно: повторный вызов
   * просто перезаписывает старый код.
   */
  async generatePairingCode(id: string): Promise<PrinterDetailDto> {
    const existing = await this.prisma.printer.findUnique({ where: { id } });
    if (!existing) throw new PrinterNotFoundException();
    const code = generatePairingCode();
    await this.prisma.printer.update({
      where: { id },
      data: { pairingCode: code },
    });
    return this.getOne(id);
  }

  /**
   * Pair агента: обменять короткий `pairingCode` на постоянный
   * `agentToken` + `printerId`. Endpoint `@Public()`, так что
   * pairingCode — это и есть единственный «секрет», по которому
   * агент авторизуется первый раз. После успеха код очищается.
   */
  async pairAgent(pairingCode: string): Promise<AgentPairResultDto> {
    const printer = await this.prisma.printer.findFirst({
      where: { pairingCode },
    });
    if (!printer) throw new PairingCodeInvalidException();
    if (!printer.isActive) throw new PrinterInactiveException();

    const token = generateAgentToken();
    const now = new Date();
    await this.prisma.printer.update({
      where: { id: printer.id },
      data: {
        agentToken: token,
        pairingCode: null,
        isOnline: true,
        lastSeenAt: now,
      },
    });
    return {
      printerId: printer.id,
      printerName: printer.name,
      agentToken: token,
    };
  }

  /**
   * Heartbeat агента — обновляем `isOnline=true` + `lastSeenAt=now`.
   * Используется и при выдаче job-ов в `PrintJobsService.pollForAgent`.
   *
   * Возвращаем текущий `selectedWindowsPrinter` принтера: пока агент
   * жив, он на каждом heartbeat-е знает актуальный выбор менеджера
   * — даже если оператор только что переключил его в UI. Это снимает
   * необходимость в отдельном GET-эндпоинте.
   */
  async heartbeat(printerId: string): Promise<string | null> {
    const updated = await this.prisma.printer.update({
      where: { id: printerId },
      data: { isOnline: true, lastSeenAt: new Date() },
      select: { selectedWindowsPrinter: true },
    });
    return updated.selectedWindowsPrinter;
  }

  /**
   * Агент сообщает свой `hostName` и список системных Windows-принтеров
   * (см. `docs/domain.md §17b «Физический Windows-принтер»`,
   * `docs/api.md §16`).
   *
   * Логика:
   *   - список перезаписывается полностью — без diff-а / истории;
   *   - `agentHostName` тоже перезаписывается (кому принадлежит
   *     станция), `windowsPrintersUpdatedAt = now`;
   *   - `selectedWindowsPrinter` НЕ трогаем: выбор менеджера переживает
   *     перезапуск агента и переоткрытие списка. Если выбранный
   *     принтер пропал из нового списка — UI это покажет, но мы
   *     намеренно не сбрасываем выбор молча, чтобы не «сломать
   *     печать» от случайного timing-а (агент успел обновить список
   *     раньше, чем менеджер увидел проблему). Сброс — явное
   *     действие через PATCH `/api/printers/:id`;
   *   - параллельно поднимаем `isOnline=true`/`lastSeenAt=now` —
   *     один сетевой вызов = одно «я жив».
   *
   * Возвращаем агенту текущий `selectedWindowsPrinter`, чтобы тому
   * не приходилось делать второй вызов: при старте процесс сразу
   * знает, на какой системный принтер печатать.
   */
  async updateWindowsPrinters(
    printerId: string,
    dto: AgentWindowsPrintersDto,
  ): Promise<AgentWindowsPrintersResultDto> {
    const dedupedPrinters = Array.from(new Set(dto.printers));
    const updated = await this.prisma.printer.update({
      where: { id: printerId },
      data: {
        agentHostName: dto.hostName,
        availableWindowsPrinters: dedupedPrinters,
        windowsPrintersUpdatedAt: new Date(),
        isOnline: true,
        lastSeenAt: new Date(),
      },
      select: {
        id: true,
        agentHostName: true,
        availableWindowsPrinters: true,
        selectedWindowsPrinter: true,
      },
    });
    return {
      printerId: updated.id,
      selectedWindowsPrinter: updated.selectedWindowsPrinter,
      availableWindowsPrinters: updated.availableWindowsPrinters,
      agentHostName: updated.agentHostName,
    };
  }

  /**
   * Агент сам выставляет физический Windows-принтер (см.
   * `POST /api/printers/agent/select-windows-printer`,
   * `apps/agent/src/wizard.mjs`). Защищён `AgentAuthGuard`-ом, так
   * что менять можно только «свой» принтер: `printerId` приходит из
   * `X-Printer-Agent-Token`, а не из тела.
   *
   * Имя обязательно должно лежать в `availableWindowsPrinters` (его
   * только что прислал тот же агент через
   * `updateWindowsPrinters`). Если нет — 422
   * `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`, та же ошибка, что и для
   * UI-PATCH — обработка единая.
   *
   * `name=null` снимает выбор (симметрично PATCH-у в UI).
   */
  async selectWindowsPrinterByAgent(
    printerId: string,
    name: string | null,
  ): Promise<AgentSelectWindowsPrinterResultDto> {
    const existing = await this.prisma.printer.findUnique({
      where: { id: printerId },
      select: { id: true, availableWindowsPrinters: true },
    });
    if (!existing) throw new PrinterNotFoundException();

    if (name !== null) {
      const allowed = existing.availableWindowsPrinters ?? [];
      if (!allowed.includes(name)) {
        throw new WindowsPrinterNotFoundForAgentException(name);
      }
    }

    const updated = await this.prisma.printer.update({
      where: { id: printerId },
      data: {
        selectedWindowsPrinter: name,
        isOnline: true,
        lastSeenAt: new Date(),
      },
      select: { id: true, selectedWindowsPrinter: true },
    });
    return {
      printerId: updated.id,
      selectedWindowsPrinter: updated.selectedWindowsPrinter,
    };
  }

  /**
   * Найти принтер по `agentToken`. Используется guard-ом
   * `agent`-эндпоинтов: если токен валиден, возвращаем принтер,
   * иначе бросаем 401 (см. `AgentAuthGuard`).
   */
  async findByAgentToken(token: string) {
    if (!token) return null;
    return this.prisma.printer.findFirst({ where: { agentToken: token } });
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private async assertEquipmentExists(equipmentId: string): Promise<void> {
    const eq = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });
    if (!eq) throw new EquipmentNotFoundException();
  }

  private isOnline(
    flag: boolean,
    lastSeenAt: Date | null,
    now: number,
  ): boolean {
    if (!flag || !lastSeenAt) return false;
    return now - lastSeenAt.getTime() <= this.ONLINE_TTL_MS;
  }
}

// ---------------------------------------------------------------------------
// Локальные исключения модуля (см. также common/errors.ts)
// ---------------------------------------------------------------------------

/**
 * Локальные ошибки модуля держим рядом, чтобы не раздувать
 * `common/errors.ts`. Контракт тот же: `{ statusCode, message, code }`.
 */
export class PrinterNotFoundException extends NotFoundException {
  constructor() {
    super({
      statusCode: 404,
      code: 'PRINTER_NOT_FOUND',
      message: 'Принтер не найден',
    });
  }
}

export class PrinterInactiveException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'PRINTER_INACTIVE',
      message: 'Принтер деактивирован',
    });
  }
}

export class PairingCodeInvalidException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'PRINTER_PAIRING_CODE_INVALID',
      message: 'Код подключения не найден или уже использован',
    });
  }
}

/**
 * Менеджер пытается выбрать `selectedWindowsPrinter`, которого нет
 * среди `availableWindowsPrinters`. Возможные причины:
 *   - агент ещё не присылал список (массив пустой);
 *   - принтер удалили на Windows-станции, агент пришлёт обновлённый
 *     список при следующем upload-е;
 *   - менеджер передал произвольную строку из старой вкладки.
 *
 * 422 (а не 409) — это семантически валидный JSON, но бизнес-правило
 * сломано: совпадает с `OPERATION_RATE_MISSING` и аналогами.
 */
export class WindowsPrinterNotFoundForAgentException extends HttpException {
  constructor(printerName: string) {
    super(
      {
        statusCode: 422,
        code: 'WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT',
        message:
          `Windows-принтер «${printerName}» отсутствует в списке, ` +
          `присланном агентом. Запустите агент рядом с принтером и ` +
          `дождитесь обновления списка.`,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Человекочитаемый pairing-код вида `PAIR-7F3A-9KQR`. Длина и алфавит
 * подобраны так, чтобы оператор мог продиктовать/набрать без ошибок
 * (без 0/O/1/I).
 */
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n: number) =>
    Array.from({ length: n }, () =>
      alphabet[randomBytes(1)[0]! % alphabet.length],
    ).join('');
  return `PAIR-${pick(4)}-${pick(4)}`;
}

/** 32-символьный hex-токен. Хранится открытым: внутренняя сеть цеха. */
export function generateAgentToken(): string {
  return randomBytes(24).toString('hex');
}
