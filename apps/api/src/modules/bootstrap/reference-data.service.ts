import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OperationCategory, PricingMode, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  REFERENCE_OPERATIONS,
  REFERENCE_SIZES,
  type ReferenceOperationSeed,
} from './reference-data.js';

/**
 * Гарантирует, что при старте API в БД есть «системные»
 * референс-данные, без которых код приложения не может работать:
 * операции (`CUT_DIVISION`, `QC`, `WTO`, `PACKING` и т. д.) и
 * базовые размеры.
 *
 * Идемпотентен: создаёт только отсутствующие строки. Существующие
 * НЕ перезаписываются — менеджер в `/admin/operations` мог
 * переименовать операцию или поменять `pricingMode`/`fixedRate`,
 * и это не должно сноситься перезапуском контейнера. Полный
 * «канонический ресет» выполняет `prisma/seed.ts` (`npm run db:seed`)
 * — он остаётся как dev/CI-инструмент.
 *
 * Запускается через `OnApplicationBootstrap`: к этому моменту все
 * модули инициализированы, но `app.listen()` ещё не вызван.
 * Если bootstrap бросит — Nest пробросит исключение, и контейнер
 * упадёт громко (вместо тихого 500-го на первом запросе).
 *
 * Закрытый кейс — «помощник раскройщика жмёт «Выпустить паспорт» в
 * проде → backend бросает `OPERATION_NOT_FOUND` («в справочнике нет
 * `CUT_DIVISION`, запустите `npm run db:seed`»)». В проде seed не
 * запускается, и без этого хука пилотная инсталляция уходила в
 * generic «server-side exception».
 *
 * Источник истины — `apps/api/src/modules/bootstrap/reference-data.ts`.
 */
@Injectable()
export class ReferenceDataBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReferenceDataBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const operations = await this.ensureOperations();
    const sizes = await this.ensureSizes();
    this.logger.log(
      `event=bootstrap.reference-data.ready operations.created=${operations.created} operations.existing=${operations.existing} sizes.created=${sizes.created} sizes.existing=${sizes.existing}`,
    );
  }

  /**
   * Создаёт отсутствующие операции из `REFERENCE_OPERATIONS`.
   * Существующие — игнорируются (не трогаем `name`/`pricingMode`/
   * `fixedRate`/`active`, чтобы не затирать ручные правки в админке).
   */
  private async ensureOperations(): Promise<{
    created: number;
    existing: number;
  }> {
    const existing = await this.prisma.operation.findMany({
      where: { code: { in: REFERENCE_OPERATIONS.map((o) => o.code) } },
      select: { code: true },
    });
    const existingCodes = new Set(existing.map((o) => o.code));
    const missing = REFERENCE_OPERATIONS.filter(
      (o) => !existingCodes.has(o.code),
    );
    if (missing.length === 0) {
      return { created: 0, existing: existing.length };
    }
    await this.prisma.operation.createMany({
      data: missing.map((op) => this.toOperationCreateInput(op)),
      skipDuplicates: true,
    });
    return { created: missing.length, existing: existing.length };
  }

  /**
   * Создаёт отсутствующие размеры. `sortOrder` берём по позиции в
   * каноничном массиве — это даёт стабильную сортировку
   * новых строк; уже созданные ряды (которые менеджер мог
   * переупорядочить) не трогаем.
   */
  private async ensureSizes(): Promise<{
    created: number;
    existing: number;
  }> {
    const existing = await this.prisma.size.findMany({
      where: { code: { in: [...REFERENCE_SIZES] } },
      select: { code: true },
    });
    const existingCodes = new Set(existing.map((s) => s.code));
    const missing: { code: string; sortOrder: number }[] = [];
    for (let i = 0; i < REFERENCE_SIZES.length; i += 1) {
      const code = REFERENCE_SIZES[i]!;
      if (existingCodes.has(code)) continue;
      missing.push({ code, sortOrder: (i + 1) * 10 });
    }
    if (missing.length === 0) {
      return { created: 0, existing: existing.length };
    }
    await this.prisma.size.createMany({
      data: missing,
      skipDuplicates: true,
    });
    return { created: missing.length, existing: existing.length };
  }

  private toOperationCreateInput(
    op: ReferenceOperationSeed,
  ): Prisma.OperationCreateManyInput {
    const fixedRate =
      op.pricingMode === 'FIXED' && op.fixedRate !== undefined
        ? new Prisma.Decimal(op.fixedRate)
        : null;
    return {
      code: op.code,
      name: op.name,
      category: op.category as OperationCategory,
      sortOrder: op.sortOrder,
      active: true,
      pricingMode: op.pricingMode as PricingMode,
      fixedRate,
    };
  }
}
