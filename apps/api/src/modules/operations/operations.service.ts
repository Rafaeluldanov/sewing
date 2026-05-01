import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PricingMode } from '@prisma/client';
import type {
  CreateOperationDto,
  OperationDetailDto,
  OperationSummaryDto,
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
 *      `PieceRate.findFirst` (см. ADR-0005 и комментарий в
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
      include: { _count: { select: { ratesBySize: true } } },
    });
    return rows.map((o) => this.toSummary(o, o._count.ratesBySize));
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
      },
    });
    if (!row) throw new OperationNotFoundException();

    const sizes = await this.prisma.size.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return {
      ...this.toSummary(row, row.ratesBySize.length),
      ratesBySize: row.ratesBySize.map((r) => ({
        sizeId: r.sizeId,
        sizeCode: r.size.code,
        sizeSortOrder: r.size.sortOrder,
        rate: Number(r.rate.toFixed(2)),
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
    if (dto.ratesBySize && dto.ratesBySize.length > 0) {
      await this.assertSizesExist(dto.ratesBySize.map((r) => r.sizeId));
    }
    const sortOrder =
      dto.sortOrder ?? (await this.nextSortOrder());

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
        return created.id;
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=operation.create id=${createdId} code=${dto.code} mode=${dto.pricingMode}`,
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
      select: { id: true, pricingMode: true },
    });
    if (!exists) throw new OperationNotFoundException();

    this.assertRatesUnique(dto.ratesBySize);
    if (dto.ratesBySize && dto.ratesBySize.length > 0) {
      await this.assertSizesExist(dto.ratesBySize.map((r) => r.sizeId));
    }

    // Финальный pricingMode: либо явно сменили, либо текущий.
    const nextMode: PricingMode = (dto.pricingMode ??
      exists.pricingMode) as PricingMode;

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
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=operation.update id=${id} mode=${nextMode}` +
        (dto.ratesBySize !== undefined
          ? ` rates=${dto.ratesBySize.length}`
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
    },
    ratesBySizeCount: number,
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
