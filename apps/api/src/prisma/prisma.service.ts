import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma client с обёрткой Nest lifecycle.
 *
 * `onModuleInit` дополнительно создаёт partial unique index, который
 * нельзя выразить в `schema.prisma` декларативно (Prisma не поддерживает
 * `@@unique(..., where: ...)`):
 *
 *   CREATE UNIQUE INDEX shift_session_active_employee_uniq
 *     ON "ShiftSession" ("employeeId") WHERE "endedAt" IS NULL;
 *
 * Это закрепляет инвариант «один открытый shift на сотрудника» на
 * уровне БД, чтобы service-side guard не оставался единственной
 * защитой (см. ADR-0015 «DB invariants MVP 1.1»). Команда идемпотентна
 * (`IF NOT EXISTS`), её безопасно гонять при каждом старте.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
    await this.applyMvp11Invariants();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  private async applyMvp11Invariants(): Promise<void> {
    try {
      await this.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "shift_session_active_employee_uniq"
           ON "ShiftSession" ("employeeId")
           WHERE "endedAt" IS NULL`,
      );
    } catch (err) {
      // Не валим старт API — иначе невозможно будет починить мусорные
      // данные через сам API. Подробности — в логе.
      this.logger.warn(
        `Не удалось применить partial unique index shift_session_active_employee_uniq: ${(err as Error).message}`,
      );
    }

    // Закрытие раскроя по размеру (ADR-0018): по одной активной
    // (REQUESTED) и по одной подтверждённой (APPROVED) заявке на
    // строку `(orderId, productId, sizeId)`. Декларативно через
    // `@@unique` Prisma этого не выражает (нет partial-where в
    // generator), поэтому держим в БД явно.
    try {
      await this.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_active_uniq"
           ON "CuttingClosureRequest" ("orderId", "productId", "sizeId")
           WHERE "status" = 'REQUESTED'`,
      );
      await this.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_approved_uniq"
           ON "CuttingClosureRequest" ("orderId", "productId", "sizeId")
           WHERE "status" = 'APPROVED'`,
      );
    } catch (err) {
      this.logger.warn(
        `Не удалось применить partial unique indexes для CuttingClosureRequest: ${(err as Error).message}`,
      );
    }
  }
}
