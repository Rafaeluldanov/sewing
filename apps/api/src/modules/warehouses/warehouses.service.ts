import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateWarehouseDto,
  CreateWarehouseLineDto,
  CreateWarehouseLineResultDto,
  PrintWarehouseCellsDto,
  PrintWarehouseCellsResultDto,
  UpdateWarehouseDto,
  WarehouseDetailDto,
  WarehouseSummaryDto,
} from '@sewing/shared/warehouses';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CellNotFoundException,
  WarehouseCodeTakenException,
  WarehouseLineCellCodeTakenException,
  WarehouseLineCodeTakenException,
  WarehouseLineHasContentException,
  WarehouseLineNoCellsToPrintException,
  WarehouseLineNotFoundException,
  WarehouseNameTakenException,
  WarehouseNoCellsToPrintException,
  WarehouseNotFoundException,
} from '../../common/errors.js';
import { buildCellPrintUrl, buildCellQrPayload } from '../passports/qr.js';
import { PrintJobsService } from '../printers/print-jobs.service.js';

/**
 * Управление складами и привязкой ячеек к складу.
 *
 * Контракт — `docs/api.md §15`. Источник истины — backend: фронт
 * только показывает то, что вернул сервис, и не дублирует валидацию
 * уникальности `name`/`code` (это инвариант БД).
 *
 * Сознательные ограничения MVP:
 *   - нет каскадного удаления склада (удаление складов вообще пока не
 *     поддержано — менеджер выключает `isActive`);
 *   - нет «зон/секций/полок» внутри склада (см. ТЗ §11 / ADR-0019).
 */
@Injectable()
export class WarehousesService {
  private readonly logger = new Logger(WarehousesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly printJobs: PrintJobsService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(): Promise<WarehouseSummaryDto[]> {
    const rows = await this.prisma.warehouse.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { cells: true } } },
    });
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      code: w.code,
      isActive: w.isActive,
      labelTemplate: w.labelTemplate,
      cellsCount: w._count.cells,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // GET ONE
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<WarehouseDetailDto> {
    const row = await this.prisma.warehouse.findUnique({
      where: { id },
      include: {
        // Сортируем ячейки сначала по линии (`A` перед «без линии»),
        // затем по порядковому номеру внутри линии (1, 2, …, 10, 11),
        // чтобы не получить лексикографическое A1, A10, A11, A2.
        // Бесхозные ячейки (lineId=null) уезжают в конец.
        cells: {
          orderBy: [
            { lineId: 'asc' },
            { lineIndex: 'asc' },
            { code: 'asc' },
          ],
        },
        lines: {
          orderBy: { code: 'asc' },
          include: { _count: { select: { cells: true } } },
        },
      },
    });
    if (!row) throw new WarehouseNotFoundException();
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      isActive: row.isActive,
      labelTemplate: row.labelTemplate,
      cellsCount: row.cells.length,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      cells: row.cells.map((c) => ({
        id: c.id,
        code: c.code,
        qrCode: c.qrCode,
        active: c.active,
        printUrl: buildCellPrintUrl(c.id),
        lineId: c.lineId,
      })),
      lines: row.lines.map((l) => ({
        id: l.id,
        code: l.code,
        cellsCount: l._count.cells,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateWarehouseDto): Promise<WarehouseDetailDto> {
    try {
      const created = await this.prisma.warehouse.create({
        data: {
          name: dto.name,
          code: dto.code ?? null,
          isActive: dto.isActive ?? true,
          labelTemplate: dto.labelTemplate ?? null,
        },
      });
      this.logger.log(
        `event=warehouse.create id=${created.id} name=${JSON.stringify(created.name)} code=${created.code ?? '-'}`,
      );
      return this.getOne(created.id);
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateWarehouseDto,
  ): Promise<WarehouseDetailDto> {
    const exists = await this.prisma.warehouse.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new WarehouseNotFoundException();

    const data: Prisma.WarehouseUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.labelTemplate !== undefined) data.labelTemplate = dto.labelTemplate;

    if (Object.keys(data).length === 0) {
      return this.getOne(id);
    }
    try {
      await this.prisma.warehouse.update({ where: { id }, data });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // ASSIGN CELL TO WAREHOUSE (PATCH /api/cells/:id)
  // -------------------------------------------------------------------------

  /**
   * Привязка/отвязка ячейки от склада. Источник истины для UI
   * `/admin/warehouses/[id]` (см. `docs/screens.md §10b`).
   *
   * Перепривязка между складами разрешена явно — это менеджерское
   * действие, которое часто нужно при перестройке стеллажей.
   * Никаких дополнительных проверок (типа «нельзя двигать активную
   * ячейку с паспортами») — складская группировка не влияет на flow
   * `place`/`issue`, см. ADR-0019.
   */
  async setCellWarehouse(
    cellId: string,
    warehouseId: string | null,
  ): Promise<{ id: string; warehouseId: string | null }> {
    const cell = await this.prisma.cell.findUnique({
      where: { id: cellId },
      select: { id: true },
    });
    if (!cell) throw new CellNotFoundException();

    if (warehouseId) {
      const wh = await this.prisma.warehouse.findUnique({
        where: { id: warehouseId },
        select: { id: true },
      });
      if (!wh) throw new WarehouseNotFoundException();
    }

    const updated = await this.prisma.cell.update({
      where: { id: cellId },
      data: { warehouseId: warehouseId ?? null },
      select: { id: true, warehouseId: true },
    });
    this.logger.log(
      `event=cell.warehouse.assign cellId=${cellId} warehouseId=${warehouseId ?? '-'}`,
    );
    return updated;
  }

  // -------------------------------------------------------------------------
  // CREATE LINE (массовое создание ячеек)
  // -------------------------------------------------------------------------

  /**
   * Массовое создание ячеек через линию (см. `docs/api.md §15`,
   * `docs/domain.md §16`). Менеджер вводит код линии и количество,
   * система создаёт `WarehouseLine` и в той же транзакции — `count`
   * ячеек с кодами `${lineCode}1`, `${lineCode}2`, …
   *
   * Инварианты:
   *   1. `WarehouseLine.code` уникален глобально (см. ADR/миграцию).
   *      Дубликат — `WAREHOUSE_LINE_CODE_TAKEN` (409).
   *   2. Каждая `Cell.code` уникальна. Если хотя бы один из планируемых
   *      кодов занят (например, A1 уже создан вручную) — транзакция
   *      откатывается целиком (`WAREHOUSE_LINE_CELL_CODE_TAKEN`).
   *   3. Все созданные ячейки сразу привязаны к складу (`warehouseId`)
   *      и к линии (`lineId`/`lineIndex`). Это управленческие группировки —
   *      flow `place`/`issue` они не задевают (ADR-0019).
   *   4. Сначала создаём ячейки с `qrCode = "cell-pending:${code}"`,
   *      затем апдейтим на `cell:${id}` (тот же приём, что в seed.ts).
   *      QR-формат `cell:{id}` (ADR-0008) не меняется — `POST /api/cells/by-code`
   *      и shelf-placement flow работают как раньше.
   */
  async createLine(
    warehouseId: string,
    dto: CreateWarehouseLineDto,
  ): Promise<CreateWarehouseLineResultDto> {
    const wh = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!wh) throw new WarehouseNotFoundException();

    // Pre-flight: проверяем уникальность кода линии. Гарантия —
    // partial unique index в БД, но здесь мы хотим отдать понятный
    // 409 до старта транзакции и до создания ячеек.
    const existingLine = await this.prisma.warehouseLine.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existingLine) {
      throw new WarehouseLineCodeTakenException(dto.code);
    }

    const cellCodes = Array.from(
      { length: dto.count },
      (_, i) => `${dto.code}${i + 1}`,
    );
    // Pre-flight по кодам ячеек: иначе пользователь увидит P2002
    // в виде сухого «Database error», а не понятный список конфликтов.
    const conflicting = await this.prisma.cell.findMany({
      where: { code: { in: cellCodes } },
      select: { code: true },
    });
    if (conflicting.length > 0) {
      throw new WarehouseLineCellCodeTakenException(
        conflicting.map((c) => c.code),
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const line = await tx.warehouseLine.create({
        data: { warehouseId, code: dto.code },
      });

      // createMany не возвращает строки — нам нужны id для `cell:{id}`.
      // Поэтому создаём по одной (count <= 200 по контракту, ОК).
      const created = [];
      for (let i = 0; i < cellCodes.length; i += 1) {
        const code = cellCodes[i]!;
        const lineIndex = i + 1;
        const row = await tx.cell.create({
          data: {
            code,
            qrCode: `cell-pending:${code}`,
            active: true,
            warehouseId,
            lineId: line.id,
            lineIndex,
          },
        });
        const finalQr = buildCellQrPayload(row.id);
        const updated = await tx.cell.update({
          where: { id: row.id },
          data: { qrCode: finalQr },
        });
        created.push(updated);
      }

      return { line, cells: created };
    });

    this.logger.log(
      `event=warehouse.line.create warehouseId=${warehouseId} ` +
        `lineId=${result.line.id} code=${result.line.code} count=${result.cells.length}`,
    );

    return {
      line: {
        id: result.line.id,
        code: result.line.code,
        cellsCount: result.cells.length,
        createdAt: result.line.createdAt.toISOString(),
      },
      cells: result.cells.map((c) => ({
        id: c.id,
        code: c.code,
        qrCode: c.qrCode,
        active: c.active,
        printUrl: buildCellPrintUrl(c.id),
        lineId: c.lineId,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // DELETE LINE (с защитой: каскадно удаляем только пустые ячейки)
  // -------------------------------------------------------------------------

  /**
   * Удаление линии склада вместе с её ячейками.
   *
   * Защита: удаляем только если ВСЕ ячейки линии «пустые» — иначе
   * `WAREHOUSE_LINE_HAS_CONTENT` (409) с перечнем «занятых» кодов.
   * «Занятой» считаем ячейку, у которой есть:
   *   - `WorkInProgressBalance` с `qty > 0` (полуфабрикат в ячейке);
   *   - `Passport.currentCellId` (паспорт сейчас лежит здесь);
   *   - `PassportEvent` (исторические события — иначе FK-констрейнт
   *     просто упадёт с непонятным P2003);
   *   - `StockBalance` с `qty > 0` (ненулевой остаток).
   *
   * Исторические `StockMovement`, `PurchaseReceiptLine`, `MaterialIssueLine`,
   * `StockBalance` с `qty == 0` — все имеют `onDelete: SetNull` и
   * безопасны: cellId/lineId обнулятся, документы останутся.
   *
   * Удаление выполняется в одной транзакции: сначала ячейки линии
   * (по одной — `deleteMany` не понадобится, ячеек ≤ 200), затем сама
   * линия. `lineId` у ячеек обнулять не нужно — мы их удаляем целиком.
   *
   * Ошибки:
   *   - 404 `WAREHOUSE_NOT_FOUND`        — склада нет;
   *   - 404 `WAREHOUSE_LINE_NOT_FOUND`   — линии нет или она у другого склада;
   *   - 409 `WAREHOUSE_LINE_HAS_CONTENT` — есть «занятые» ячейки.
   */
  async deleteLine(warehouseId: string, lineId: string): Promise<void> {
    const wh = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!wh) throw new WarehouseNotFoundException();

    const line = await this.prisma.warehouseLine.findUnique({
      where: { id: lineId },
      select: { id: true, code: true, warehouseId: true },
    });
    if (!line || line.warehouseId !== warehouseId) {
      throw new WarehouseLineNotFoundException();
    }

    // Берём ячейки линии вместе с признаками занятости. `_count`
    // покрывает currentPassports / events; для StockBalance и
    // WorkInProgressBalance с `qty > 0` нужен явный where, поэтому
    // подгружаем балансы и фильтруем в JS.
    const cells = await this.prisma.cell.findMany({
      where: { lineId },
      select: {
        id: true,
        code: true,
        _count: {
          select: {
            currentPassports: true,
            events: true,
          },
        },
        stockBalances: { select: { qty: true } },
        workInProgressBalances: { select: { qty: true } },
      },
    });

    const busyCodes: string[] = [];
    for (const c of cells) {
      const hasPassport = c._count.currentPassports > 0;
      const hasEvents = c._count.events > 0;
      const hasStock = c.stockBalances.some((b) => Number(b.qty) > 0);
      const hasWip = c.workInProgressBalances.some((b) => b.qty > 0);
      if (hasPassport || hasEvents || hasStock || hasWip) {
        busyCodes.push(c.code);
      }
    }
    if (busyCodes.length > 0) {
      throw new WarehouseLineHasContentException(busyCodes);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.cell.deleteMany({ where: { lineId } });
      await tx.warehouseLine.delete({ where: { id: lineId } });
    });

    this.logger.log(
      `event=warehouse.line.delete warehouseId=${warehouseId} ` +
        `lineId=${lineId} code=${line.code} cellsDeleted=${cells.length}`,
    );
  }

  // -------------------------------------------------------------------------
  // BULK PRINT (массовая печать всех ячеек склада)
  // -------------------------------------------------------------------------

  /**
   * Список ячеек склада в стабильном порядке печати — линия (`A`
   * раньше «без линии»), затем `lineIndex` (1, 2, …), затем `code` для
   * детерминизма. Используется и для preview в UI, и для batch-job-ов.
   *
   * Возвращаем только активные ячейки — деактивированные печатать
   * бессмысленно (это ровно тот сигнал, ради которого менеджер их и
   * выключает в админке).
   */
  async listPrintableCells(warehouseId: string): Promise<
    Array<{ id: string; code: string; lineCode: string | null }>
  > {
    const wh = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!wh) throw new WarehouseNotFoundException();

    const rows = await this.prisma.cell.findMany({
      where: { warehouseId, active: true },
      orderBy: [
        { lineId: 'asc' },
        { lineIndex: 'asc' },
        { code: 'asc' },
      ],
      select: {
        id: true,
        code: true,
        line: { select: { code: true } },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      code: c.code,
      lineCode: c.line?.code ?? null,
    }));
  }

  /**
   * Массовая печать «Печать всех ячеек» из карточки склада
   * (см. `docs/api.md §15`, `docs/screens.md §10b`).
   *
   * Логика:
   *   1. Берём все активные ячейки склада в стабильном порядке.
   *   2. Для каждой ячейки создаём `copies` PENDING-job-ов с
   *      `sourceType=CELL_LABEL` (готовая 38×58 этикетка через
   *      `/api/cells/:id/print`).
   *   3. Все job-ы отправляются на ОДИН логический принтер
   *      (`printerId` явно передан менеджером в UI). Агент рядом с
   *      этим принтером заберёт очередь FIFO.
   *   4. Если на складе нет активных ячеек — отдаём
   *      `WAREHOUSE_NO_CELLS_TO_PRINT` (409), чтобы UI показал
   *      понятный empty-state. Кнопка в этом случае ещё и
   *      disabled на фронте, но валидируем и на backend.
   *
   * `apiBaseUrl` приходит из контроллера (см. `resolvePublicApiBaseUrl`),
   * чтобы payload-URL был доступен агенту, а не loopback-адресом
   * Next.js SSR.
   */
  async printAllCells(
    warehouseId: string,
    dto: PrintWarehouseCellsDto,
    apiBaseUrl: string,
  ): Promise<PrintWarehouseCellsResultDto> {
    const cells = await this.listPrintableCells(warehouseId);
    if (cells.length === 0) {
      throw new WarehouseNoCellsToPrintException();
    }

    const items: Array<{ sourceType: 'CELL_LABEL'; sourceId: string }> = [];
    for (const cell of cells) {
      for (let copy = 0; copy < dto.copies; copy += 1) {
        items.push({ sourceType: 'CELL_LABEL', sourceId: cell.id });
      }
    }

    const result = await this.printJobs.createBatch(
      dto.printerId,
      items,
      apiBaseUrl,
    );

    this.logger.log(
      `event=warehouse.print-cells warehouseId=${warehouseId} ` +
        `printerId=${dto.printerId} cells=${cells.length} ` +
        `copies=${dto.copies} jobsCreated=${result.jobsCreated} ` +
        `labelSize=${dto.labelSize}`,
    );

    return {
      warehouseId,
      printerId: dto.printerId,
      cellsCount: cells.length,
      copies: dto.copies,
      jobsCreated: result.jobsCreated,
      labelSize: dto.labelSize,
    };
  }

  /**
   * Печать всех активных ячеек одной линии (per-line вариант
   * `printAllCells`). Принтер/копии/размер — те же поля, что и в
   * массовой печати склада.
   *
   * Ошибки:
   *   - 404 `WAREHOUSE_NOT_FOUND`              — склада нет;
   *   - 404 `WAREHOUSE_LINE_NOT_FOUND`         — линия не принадлежит складу;
   *   - 404 `PRINTER_NOT_FOUND` / 409 `PRINTER_INACTIVE` — из `PrintJobsService`;
   *   - 409 `WAREHOUSE_LINE_NO_CELLS_TO_PRINT` — в линии нет активных ячеек.
   */
  async printLineCells(
    warehouseId: string,
    lineId: string,
    dto: PrintWarehouseCellsDto,
    apiBaseUrl: string,
  ): Promise<PrintWarehouseCellsResultDto> {
    const wh = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!wh) throw new WarehouseNotFoundException();

    const line = await this.prisma.warehouseLine.findUnique({
      where: { id: lineId },
      select: { id: true, warehouseId: true, code: true },
    });
    if (!line || line.warehouseId !== warehouseId) {
      throw new WarehouseLineNotFoundException();
    }

    const cells = await this.prisma.cell.findMany({
      where: { warehouseId, lineId, active: true },
      orderBy: [{ lineIndex: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true },
    });
    if (cells.length === 0) {
      throw new WarehouseLineNoCellsToPrintException();
    }

    const items: Array<{ sourceType: 'CELL_LABEL'; sourceId: string }> = [];
    for (const cell of cells) {
      for (let copy = 0; copy < dto.copies; copy += 1) {
        items.push({ sourceType: 'CELL_LABEL', sourceId: cell.id });
      }
    }

    const result = await this.printJobs.createBatch(
      dto.printerId,
      items,
      apiBaseUrl,
    );

    this.logger.log(
      `event=warehouse.line.print-cells warehouseId=${warehouseId} ` +
        `lineId=${lineId} lineCode=${line.code} printerId=${dto.printerId} ` +
        `cells=${cells.length} copies=${dto.copies} ` +
        `jobsCreated=${result.jobsCreated} labelSize=${dto.labelSize}`,
    );

    return {
      warehouseId,
      printerId: dto.printerId,
      cellsCount: cells.length,
      copies: dto.copies,
      jobsCreated: result.jobsCreated,
      labelSize: dto.labelSize,
    };
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Превращает Prisma-ошибку P2002 (нарушение unique) в человекочитаемую
   * бизнес-ошибку. Имена полей берём из `meta.target`, чтобы UI мог
   * показать точный месседж — «имя занято» vs «код занят».
   */
  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('name'))) {
        throw new WarehouseNameTakenException();
      }
      if (fields.some((f) => String(f).includes('code'))) {
        throw new WarehouseCodeTakenException();
      }
    }
  }
}
