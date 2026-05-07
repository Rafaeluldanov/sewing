import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PricingMode } from '@prisma/client';
import type {
  CreateOperationDto,
  OperationDetailDto,
  OperationSummaryDto,
  TimeNormMode,
  UpdateOperationDto,
} from '@sewing/shared/operations';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OperationCodeTakenException,
  OperationNotFoundException,
  OperationRateDuplicateSizeException,
  OperationRateMissingException,
  OperationRateSizeNotFoundException,
} from '../../common/errors.js';

/**
 * Управляющий сервис для блока «Операции» (см. `docs/domain.md §16a`,
 * `docs/api.md §15a`, `docs/screens.md §10c`).
 *
 * Отвечает за:
 *   1. CRUD операций (`list`, `getOne`, `create`, `update`).
 *   2. Согласованную смену `pricingMode` с очисткой/перезаписью
 *      ставок в одной транзакции.
 *   3. Источник истины для сдельных начислений — `resolveRate(...)`,
 *      который использует `EarningsService` вместо устаревшего
 *      исторический `PieceRate.findFirst` (таблица удалена в PHASE 2 STEP 1; см. ADR-0005 и комментарий в
 *      `EarningsService`).
 *
 * Сознательные ограничения MVP:
 *   - один тариф на пару `(operationId, sizeId)`, без истории;
 *   - без привязки к продукту/сотруднику/складу/селлеру;
 *   - удаление операции не поддерживаем — менеджер выключает `isActive`.
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(): Promise<OperationSummaryDto[]> {
    const rows = await this.prisma.operation.findMany({
      orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }],
      include: {
        _count: {
          select: { ratesBySize: true, timeNormsBySize: true },
        },
      },
    });
    return rows.map((o) =>
      this.toSummary(o, o._count.ratesBySize, o._count.timeNormsBySize),
    );
  }

  // -------------------------------------------------------------------------
  // GET ONE
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<OperationDetailDto> {
    const row = await this.prisma.operation.findUnique({
      where: { id },
      include: {
        ratesBySize: {
          include: { size: true },
          orderBy: { size: { sortOrder: 'asc' } },
        },
        timeNormsBySize: {
          include: { size: true },
          orderBy: { size: { sortOrder: 'asc' } },
        },
      },
    });
    if (!row) throw new OperationNotFoundException();

    const sizes = await this.prisma.size.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return {
      ...this.toSummary(row, row.ratesBySize.length, row.timeNormsBySize.length),
      ratesBySize: row.ratesBySize.map((r) => ({
        sizeId: r.sizeId,
        sizeCode: r.size.code,
        sizeSortOrder: r.size.sortOrder,
        rate: Number(r.rate.toFixed(2)),
      })),
      timeNormsBySize: row.timeNormsBySize.map((r) => ({
        sizeId: r.sizeId,
        sizeCode: r.size.code,
        sizeSortOrder: r.size.sortOrder,
        seconds: r.seconds,
      })),
      sizes: sizes.map((s) => ({
        id: s.id,
        code: s.code,
        sortOrder: s.sortOrder,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateOperationDto): Promise<OperationDetailDto> {
    this.assertRatesUnique(dto.ratesBySize);
    this.assertTimeNormsUnique(dto.timeNormsBySize);
    if (dto.ratesBySize && dto.ratesBySize.length > 0) {
      await this.assertSizesExist(dto.ratesBySize.map((r) => r.sizeId));
    }
    if (dto.timeNormsBySize && dto.timeNormsBySize.length > 0) {
      await this.assertSizesExist(dto.timeNormsBySize.map((r) => r.sizeId));
    }
    const sortOrder =
      dto.sortOrder ?? (await this.nextSortOrder());

    const timeNormMode: TimeNormMode = dto.timeNormMode ?? 'FIXED';
    const timeNormSec =
      timeNormMode === 'FIXED' && dto.timeNormSec != null
        ? dto.timeNormSec
        : null;

    // Плановая окладная стоимость (см. ТЗ «Плановая стоимость
    // окладных операций»). Это **отдельная ось** от pricingMode/
    // timeNormMode и от фактического payroll. Если указана ставка,
    // но не указана длительность смены — подставляем default 28800
    // (8 часов), чтобы UI сразу мог показать «cost per second».
    const salaryPlanRubPerShift =
      dto.salaryPlanRubPerShift != null
        ? new Prisma.Decimal(dto.salaryPlanRubPerShift)
        : null;
    const salaryPlanShiftSeconds = resolveSalaryPlanShiftSeconds(
      dto.salaryPlanShiftSeconds,
      salaryPlanRubPerShift !== null,
    );

    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.operation.create({
          data: {
            code: dto.code,
            name: dto.name,
            category: dto.category,
            sortOrder,
            active: dto.isActive ?? true,
            pricingMode: dto.pricingMode,
            fixedRate:
              dto.pricingMode === 'FIXED' && dto.fixedRate !== undefined
                ? new Prisma.Decimal(dto.fixedRate)
                : null,
            timeNormMode,
            timeNormSec,
            salaryPlanRubPerShift,
            salaryPlanShiftSeconds,
            producesFinishedGoods: dto.producesFinishedGoods ?? false,
          },
        });
        if (dto.pricingMode === 'BY_SIZE' && dto.ratesBySize?.length) {
          await tx.operationRateBySize.createMany({
            data: dto.ratesBySize.map((r) => ({
              operationId: created.id,
              sizeId: r.sizeId,
              rate: new Prisma.Decimal(r.rate),
            })),
          });
        }
        if (timeNormMode === 'BY_SIZE' && dto.timeNormsBySize?.length) {
          await tx.operationTimeNormBySize.createMany({
            data: dto.timeNormsBySize.map((r) => ({
              operationId: created.id,
              sizeId: r.sizeId,
              seconds: r.seconds,
            })),
          });
        }
        return created.id;
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=operation.create id=${createdId} code=${dto.code} ` +
        `mode=${dto.pricingMode} timeMode=${timeNormMode}`,
    );
    return this.getOne(createdId);
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateOperationDto,
  ): Promise<OperationDetailDto> {
    const exists = await this.prisma.operation.findUnique({
      where: { id },
      select: {
        id: true,
        pricingMode: true,
        timeNormMode: true,
        salaryPlanShiftSeconds: true,
      },
    });
    if (!exists) throw new OperationNotFoundException();

    this.assertRatesUnique(dto.ratesBySize);
    this.assertTimeNormsUnique(dto.timeNormsBySize);
    if (dto.ratesBySize && dto.ratesBySize.length > 0) {
      await this.assertSizesExist(dto.ratesBySize.map((r) => r.sizeId));
    }
    if (dto.timeNormsBySize && dto.timeNormsBySize.length > 0) {
      await this.assertSizesExist(dto.timeNormsBySize.map((r) => r.sizeId));
    }

    // Финальный pricingMode: либо явно сменили, либо текущий.
    const nextMode: PricingMode = (dto.pricingMode ??
      exists.pricingMode) as PricingMode;
    // Финальный timeNormMode: либо явно сменили, либо текущий.
    // Это **отдельная ось** от pricingMode.
    const nextTimeMode: TimeNormMode = (dto.timeNormMode ??
      exists.timeNormMode) as TimeNormMode;

    // Доп. валидация переходов и согласованность ставок.
    // Делаем это здесь, а не в Zod, потому что это требует знания
    // текущего pricingMode из БД.
    if (nextMode === 'FIXED' && dto.ratesBySize && dto.ratesBySize.length > 0) {
      throw new OperationRateMissingException('FIXED', '*');
    }
    if (nextMode === 'SALARY_ONLY') {
      if (dto.fixedRate !== undefined && dto.fixedRate !== null) {
        // Защита от перепутанных полей: в SALARY_ONLY ставка не нужна.
        // Тихо обнуляем — UI всё равно её спрятал бы.
        dto.fixedRate = null;
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.OperationUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.category !== undefined) data.category = dto.category;
        if (dto.isActive !== undefined) data.active = dto.isActive;
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
        if (dto.pricingMode !== undefined) data.pricingMode = dto.pricingMode;
        if (dto.timeNormMode !== undefined) data.timeNormMode = dto.timeNormMode;

        // Согласованность fixedRate с pricingMode:
        //   FIXED       → если пришёл fixedRate, ставим его;
        //   BY_SIZE     → всегда обнуляем fixedRate;
        //   SALARY_ONLY → всегда обнуляем fixedRate.
        if (nextMode === 'FIXED') {
          if (dto.fixedRate !== undefined) {
            data.fixedRate =
              dto.fixedRate === null
                ? null
                : new Prisma.Decimal(dto.fixedRate);
          }
        } else {
          data.fixedRate = null;
        }

        // Согласованность timeNormSec с timeNormMode:
        //   FIXED   → если пришёл timeNormSec, ставим его (включая null);
        //   BY_SIZE → всегда обнуляем timeNormSec.
        if (nextTimeMode === 'FIXED') {
          if (dto.timeNormSec !== undefined) {
            data.timeNormSec = dto.timeNormSec === null ? null : dto.timeNormSec;
          }
        } else {
          data.timeNormSec = null;
        }

        // Плановая окладная ставка (см. ТЗ «Плановая стоимость
        // окладных операций»). Это **отдельная ось** от pricingMode/
        // timeNormMode — поле обновляется независимо. Контракт:
        //   - `salaryPlanRubPerShift = null` → обнулить;
        //   - `salaryPlanRubPerShift = number` → проставить;
        //   - не пришло — не трогать.
        // Длительность смены: если ставка задана, но shift seconds
        // в БД ещё `null`, бэкенд проставляет default 28800 в
        // дополнение, чтобы UI/расчёт плана не упирался в null/0.
        if (dto.salaryPlanRubPerShift !== undefined) {
          data.salaryPlanRubPerShift =
            dto.salaryPlanRubPerShift === null
              ? null
              : new Prisma.Decimal(dto.salaryPlanRubPerShift);
        }
        if (dto.salaryPlanShiftSeconds !== undefined) {
          data.salaryPlanShiftSeconds =
            dto.salaryPlanShiftSeconds === null
              ? 28800
              : dto.salaryPlanShiftSeconds;
        } else if (
          dto.salaryPlanRubPerShift != null &&
          (exists as { salaryPlanShiftSeconds: number | null })
            .salaryPlanShiftSeconds == null
        ) {
          // Ставку только что задали, а длительность смены так и не
          // была проставлена — подставляем default, чтобы расчёт
          // плана сразу заработал.
          data.salaryPlanShiftSeconds = 28800;
        }

        // Признак «операция выпускает готовую продукцию» (см.
        // `prisma/schema.prisma::Operation.producesFinishedGoods`,
        // `FinishedGoodsService.recordPassportOutputInTx`). Принимает
        // `true` / `false`; не пришло — поле не трогаем. Уже выпущенные
        // паспорты не пересоздаются: идемпотентность по
        // `sourceKey = PACKED_PASSPORT:<passportId>` гарантирует
        // ровно одно `FinishedGoodsMovement PRODUCTION_RECEIPT IN`
        // на паспорт.
        if (dto.producesFinishedGoods !== undefined) {
          data.producesFinishedGoods = dto.producesFinishedGoods;
        }

        await tx.operation.update({ where: { id }, data });

        // Согласованность OperationRateBySize:
        //   BY_SIZE с явно переданным ratesBySize → replace-all;
        //   BY_SIZE без ratesBySize, но смена режима с другого → ничего
        //     (менеджер заполнит на следующем шаге; UI это покажет);
        //   FIXED / SALARY_ONLY → стираем все ставки, чтобы инвариант
        //     «BY_SIZE => есть ставки, остальное => нет ставок» жил.
        if (nextMode === 'BY_SIZE') {
          if (dto.ratesBySize !== undefined) {
            await tx.operationRateBySize.deleteMany({
              where: { operationId: id },
            });
            if (dto.ratesBySize.length > 0) {
              await tx.operationRateBySize.createMany({
                data: dto.ratesBySize.map((r) => ({
                  operationId: id,
                  sizeId: r.sizeId,
                  rate: new Prisma.Decimal(r.rate),
                })),
              });
            }
          }
        } else {
          await tx.operationRateBySize.deleteMany({
            where: { operationId: id },
          });
        }

        // Согласованность OperationTimeNormBySize по тому же паттерну,
        // но на отдельной оси `timeNormMode`:
        //   BY_SIZE с явно переданным timeNormsBySize → replace-all;
        //   BY_SIZE без timeNormsBySize и смена режима — оставляем
        //     текущие строки (менеджер заполнит постепенно);
        //   FIXED — стираем все строки, чтобы инвариант
        //     «BY_SIZE => есть нормы, FIXED => нет норм» держался.
        if (nextTimeMode === 'BY_SIZE') {
          if (dto.timeNormsBySize !== undefined) {
            await tx.operationTimeNormBySize.deleteMany({
              where: { operationId: id },
            });
            if (dto.timeNormsBySize.length > 0) {
              await tx.operationTimeNormBySize.createMany({
                data: dto.timeNormsBySize.map((r) => ({
                  operationId: id,
                  sizeId: r.sizeId,
                  seconds: r.seconds,
                })),
              });
            }
          }
        } else {
          await tx.operationTimeNormBySize.deleteMany({
            where: { operationId: id },
          });
        }
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=operation.update id=${id} mode=${nextMode} timeMode=${nextTimeMode}` +
        (dto.ratesBySize !== undefined
          ? ` rates=${dto.ratesBySize.length}`
          : '') +
        (dto.timeNormsBySize !== undefined
          ? ` timeNorms=${dto.timeNormsBySize.length}`
          : ''),
    );
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // RESOLVE RATE (источник истины для сдельных начислений)
  // -------------------------------------------------------------------------

  /**
   * Возвращает ставку за единицу для операции в зависимости от её
   * `pricingMode`. Контракт:
   *
   *   - `FIXED` → `Operation.fixedRate` (если `null` — это
   *     невалидная конфигурация, бросаем `OperationRateMissingException`);
   *   - `BY_SIZE` → строка `OperationRateBySize` для (operationId, sizeId);
   *     если её нет — `OperationRateMissingException`;
   *   - `SALARY_ONLY` → `null` (вызывающий код должен пропустить
   *     создание piece-rate начисления).
   *
   * Принимает опциональный `tx`, чтобы вызываться из той же транзакции,
   * что и создание `OperationEntry`. В EarningsService это критично —
   * см. ADR-0012 и `EarningsService.createImmediateForCutter`.
   */
  async resolveRate(
    operationId: string,
    sizeId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal | null> {
    const client: Prisma.TransactionClient | PrismaService = tx ?? this.prisma;
    const op = await client.operation.findUnique({
      where: { id: operationId },
      select: { id: true, code: true, pricingMode: true, fixedRate: true },
    });
    if (!op) throw new OperationNotFoundException();

    if (op.pricingMode === 'SALARY_ONLY') return null;

    if (op.pricingMode === 'FIXED') {
      if (!op.fixedRate) {
        const sz = await client.size.findUnique({
          where: { id: sizeId },
          select: { code: true },
        });
        throw new OperationRateMissingException(op.code, sz?.code ?? sizeId);
      }
      return op.fixedRate;
    }

    // BY_SIZE
    const row = await client.operationRateBySize.findUnique({
      where: {
        OperationRateBySize_operation_size_uniq: {
          operationId,
          sizeId,
        },
      },
      select: { rate: true },
    });
    if (!row) {
      const sz = await client.size.findUnique({
        where: { id: sizeId },
        select: { code: true },
      });
      throw new OperationRateMissingException(op.code, sz?.code ?? sizeId);
    }
    return row.rate;
  }

  // -------------------------------------------------------------------------
  // RESOLVE SALARY PLAN COST PER SECOND (плановая себестоимость
  // окладных операций; см. ТЗ «Плановая стоимость окладных операций»)
  // -------------------------------------------------------------------------

  /**
   * Возвращает плановую стоимость 1 секунды операции для расчёта
   * **плановой** себестоимости окладных операций
   * (`pricingMode = SALARY_ONLY`). Это не фактическая зарплата —
   * payroll (`SalaryService`, `EarningsService`,
   * `Employee.salaryPerShift`) этой формулы не использует.
   *
   * Контракт:
   *   - `salaryPlanRubPerShift = null` → `null` (план для окладных
   *     операций пропускается; `OrderOperationPlanService` ставит
   *     `cost = 0` + warning);
   *   - `salaryPlanRubPerShift > 0` и `salaryPlanShiftSeconds > 0` →
   *     `Decimal(salaryPlanRubPerShift) / salaryPlanShiftSeconds`;
   *   - `salaryPlanRubPerShift > 0`, но `salaryPlanShiftSeconds`
   *     `null/0` → fallback на 28800 (default «8-часовая смена»),
   *     чтобы не блокировать план.
   *
   * Возвращает `Prisma.Decimal | null`, чтобы вызывающий код мог
   * умножить на (timeSec × qty) без потери точности.
   */
  resolveSalaryPlanCostPerSecond(operation: {
    salaryPlanRubPerShift: Prisma.Decimal | null;
    salaryPlanShiftSeconds: number | null;
  }): Prisma.Decimal | null {
    if (operation.salaryPlanRubPerShift == null) return null;
    const shiftSec =
      operation.salaryPlanShiftSeconds && operation.salaryPlanShiftSeconds > 0
        ? operation.salaryPlanShiftSeconds
        : 28800;
    return operation.salaryPlanRubPerShift.div(shiftSec);
  }

  // -------------------------------------------------------------------------
  // RESOLVE TIME NORM (источник истины для плана времени)
  // -------------------------------------------------------------------------

  /**
   * Возвращает плановую норму времени операции в зависимости от её
   * `timeNormMode`. Это **отдельная ось** от `resolveRate(...)` —
   * payroll этим методом не пользуется. Контракт сознательно мягче,
   * чем у `resolveRate`: вместо exception «нормы нет» — возвращаем
   * `null`. Заказ не должен блокироваться отсутствием плановой нормы
   * (см. `docs/operation-time-norms-recon.md §11`):
   *
   *   - `FIXED`   → `Operation.timeNormSec ?? null`;
   *   - `BY_SIZE` → `OperationTimeNormBySize.seconds` для пары или `null`.
   *
   * Если операции не существует — `OperationNotFoundException`
   * (по тому же стилю, что и `resolveRate`).
   *
   * Принимает опциональный `tx`, чтобы вызываться из той же транзакции,
   * что и расчёт плана заказа (см. recon §11).
   */
  async resolveTimeNormSec(
    operationId: string,
    sizeId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number | null> {
    const client: Prisma.TransactionClient | PrismaService = tx ?? this.prisma;
    const op = await client.operation.findUnique({
      where: { id: operationId },
      select: { id: true, timeNormMode: true, timeNormSec: true },
    });
    if (!op) throw new OperationNotFoundException();

    if (op.timeNormMode === 'FIXED') {
      return op.timeNormSec ?? null;
    }

    // BY_SIZE
    const row = await client.operationTimeNormBySize.findUnique({
      where: {
        OperationTimeNormBySize_operation_size_uniq: {
          operationId,
          sizeId,
        },
      },
      select: { seconds: true },
    });
    return row?.seconds ?? null;
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private toSummary(
    row: {
      id: string;
      code: string;
      name: string;
      category: string;
      pricingMode: string;
      fixedRate: Prisma.Decimal | null;
      active: boolean;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
      timeNormMode: string;
      timeNormSec: number | null;
      salaryPlanRubPerShift: Prisma.Decimal | null;
      salaryPlanShiftSeconds: number | null;
      producesFinishedGoods: boolean;
    },
    ratesBySizeCount: number,
    timeNormsBySizeCount: number,
  ): OperationSummaryDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category as OperationSummaryDto['category'],
      pricingMode: row.pricingMode as OperationSummaryDto['pricingMode'],
      fixedRate: row.fixedRate ? Number(row.fixedRate.toFixed(2)) : null,
      ratesBySizeCount,
      isActive: row.active,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      timeNormMode: row.timeNormMode as OperationSummaryDto['timeNormMode'],
      timeNormSec: row.timeNormSec ?? null,
      timeNormsBySizeCount,
      salaryPlanRubPerShift: row.salaryPlanRubPerShift
        ? Number(row.salaryPlanRubPerShift.toFixed(2))
        : null,
      salaryPlanShiftSeconds: row.salaryPlanShiftSeconds ?? null,
      producesFinishedGoods: row.producesFinishedGoods,
    };
  }

  private async nextSortOrder(): Promise<number> {
    const max = await this.prisma.operation.aggregate({
      _max: { sortOrder: true },
    });
    return (max._max.sortOrder ?? 0) + 10;
  }

  private assertRatesUnique(
    rates: Array<{ sizeId: string }> | undefined,
  ): void {
    if (!rates) return;
    const seen = new Set<string>();
    for (const r of rates) {
      if (seen.has(r.sizeId)) {
        throw new OperationRateDuplicateSizeException(r.sizeId);
      }
      seen.add(r.sizeId);
    }
  }

  private assertTimeNormsUnique(
    norms: Array<{ sizeId: string }> | undefined,
  ): void {
    if (!norms) return;
    const seen = new Set<string>();
    for (const r of norms) {
      if (seen.has(r.sizeId)) {
        throw new OperationRateDuplicateSizeException(r.sizeId);
      }
      seen.add(r.sizeId);
    }
  }

  private async assertSizesExist(sizeIds: string[]): Promise<void> {
    const found = await this.prisma.size.findMany({
      where: { id: { in: sizeIds } },
      select: { id: true },
    });
    const foundSet = new Set(found.map((s) => s.id));
    for (const id of sizeIds) {
      if (!foundSet.has(id)) {
        throw new OperationRateSizeNotFoundException(id);
      }
    }
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('code'))) {
        throw new OperationCodeTakenException();
      }
    }
  }
}

/**
 * Привести `salaryPlanShiftSeconds` из DTO к значению, которое уйдёт
 * в БД на `create()`. Контракт:
 *   - DTO явно прислал число > 0 → используем его;
 *   - DTO прислал `null` → `28800` (default; это безопасно даже без
 *     ставки, потому что shift seconds одиночно не имеет смысла);
 *   - DTO опустил поле → `28800` если ставка задана, иначе оставим
 *     `null` — DDL-default (`28800`) сработает в Postgres.
 *
 * Прямо в Prisma поле `default(28800)` стоит, но Prisma client при
 * `data.salaryPlanShiftSeconds = undefined` всё равно опускает
 * колонку — это тот случай, когда database default сработает
 * корректно. Возвращаем `null` (а не `undefined`), чтобы Prisma
 * проинтерпретировала это как «оставь как есть в БД» только когда
 * нам это нужно — в `create()` мы хотим явный default.
 */
function resolveSalaryPlanShiftSeconds(
  dtoValue: number | null | undefined,
  hasRate: boolean,
): number | null {
  if (dtoValue !== undefined && dtoValue !== null && dtoValue > 0) {
    return dtoValue;
  }
  if (dtoValue === null) return 28800;
  // dtoValue === undefined: оставляем default БД, но если ставка
  // указана — лучше явно проставить 28800, чтобы UI не путался.
  return hasRate ? 28800 : null;
}
