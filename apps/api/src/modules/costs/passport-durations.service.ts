import { Injectable } from '@nestjs/common';
import {
  OperationCategory,
  PassportEventType,
  type Prisma,
} from '@prisma/client';
import { MAX_STAGE_MINUTES_PER_PASSPORT } from '@sewing/shared/costs';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Длительность стадии (`QC` / `WTO` / `PACKING`) по одному паспорту,
 * по одному сотруднику-исполнителю, на одну дату завершения.
 *
 * Минуты округляются до целого вверх (любая ненулевая работа считается
 * минимум за 1 минуту), и cap-ятся `MAX_STAGE_MINUTES_PER_PASSPORT`,
 * чтобы «забыл закрыть» не съедал смену целиком.
 */
export interface StageDuration {
  passportId: string;
  employeeId: string;
  /** Категория стадии — какая роль её обработала. */
  stage: 'QC' | 'WTO' | 'PACKING';
  /** Дата завершения стадии (UTC, начало суток). */
  completedAt: Date;
  /** Уже cap-нутая длительность в минутах. */
  durationMinutes: number;
  /** Сырая (до cap) длительность — нужна тестам/отладке. */
  rawDurationMinutes: number;
  /** True, если применили cap. */
  capped: boolean;
}

/**
 * Сервис расчёта длительностей стадий по `PassportEvent`.
 *
 * Используется `CostsService` и не зависит ни от каких новых полей в
 * БД — мы извлекаем длительности из существующего журнала событий
 * (`docs/events.md`, см. `OPERATION_SCAN`, `QC_PASSED`, `WTO_PASSED`,
 * `PACKED`).
 *
 * Семантика «accept → complete» по стадиям:
 *
 *   QC      acceptedAt = первый `OPERATION_SCAN` с
 *           `operation.category = QC` после самого свежего `QC_PASSED`
 *           (или с момента создания паспорта, если `QC_PASSED` ещё не
 *           было); completedAt = ближайший `QC_PASSED` после accept.
 *           Исполнитель = employeeId из QC_PASSED.
 *
 *   WTO     то же самое, но `OperationCategory.IRONING` и
 *           `WTO_PASSED`.
 *
 *   PACKING На MVP отдельного `OPERATION_SCAN` для упаковки нет
 *           (см. `PackingService.addPassport` — пишется только PACKED),
 *           поэтому длительность считается «по разрыву»:
 *             accept = max(
 *               предыдущий PACKED того же упаковщика в той же UTC-дате,
 *               currentPacked − MAX_STAGE_MINUTES_PER_PASSPORT,
 *             );
 *           если предыдущего PACKED у этого упаковщика в этот день нет
 *           вовсе — берём `WTO_PASSED` этого паспорта (то есть «время от
 *           готовности к упаковке до факта упаковки»), но не более cap.
 *           Исполнитель = employeeId из PACKED.
 *
 * Все ограничения «по одному паспорту максимум одна стадия каждого
 * типа за период» — сознательны: повторный заход в QC после
 * `DEFECT_RECORDED` и нового пошива на MVP фиксируется как
 * ОДНА стадия (последняя). Этого достаточно для управленческой
 * картины: пилот не оптимизирует на повторных заходах.
 */
@Injectable()
export class PassportDurationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Все длительности стадий за период `[from..to]` (включительно по
   * `completedAt`). Источник истины — журнал `PassportEvent`.
   *
   * Возвращает развернутый плоский список — агрегации делает
   * `CostsService` (ему удобнее группировать по сотруднику и дню).
   */
  async listForPeriod(
    from: Date,
    to: Date,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<StageDuration[]> {
    // Берём все «терминальные» события стадий за период, плюс все
    // OPERATION_SCAN-ы по тем же паспортам — это даёт нам точку
    // accept. Чтобы не тащить весь лог, сначала находим passportId
    // через QC_PASSED/WTO_PASSED/PACKED в окне.
    const completes = await tx.passportEvent.findMany({
      where: {
        type: {
          in: [
            PassportEventType.QC_PASSED,
            PassportEventType.WTO_PASSED,
            PassportEventType.PACKED,
          ],
        },
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        passportId: true,
        type: true,
        employeeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (completes.length === 0) return [];

    const passportIds = Array.from(
      new Set(completes.map((c) => c.passportId)),
    );

    // Все скан-события категорий QC/IRONING/PACKING для этих паспортов.
    // Беём всю историю, потому что `acceptedAt` для самого свежего
    // QC_PASSED может лежать раньше окна выборки.
    const scans = await tx.passportEvent.findMany({
      where: {
        passportId: { in: passportIds },
        type: PassportEventType.OPERATION_SCAN,
        operation: {
          category: {
            in: [
              OperationCategory.QC,
              OperationCategory.IRONING,
              OperationCategory.PACKING,
            ],
          },
        },
      },
      include: {
        operation: { select: { id: true, category: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const scansByPassport = new Map<
      string,
      Array<{
        createdAt: Date;
        category: OperationCategory;
      }>
    >();
    for (const s of scans) {
      if (!s.operation) continue;
      const arr = scansByPassport.get(s.passportId) ?? [];
      arr.push({ createdAt: s.createdAt, category: s.operation.category });
      scansByPassport.set(s.passportId, arr);
    }

    // Для PACKING держим cursor «последний PACKED того же упаковщика в
    // ту же UTC-дату» — accept упаковки выводится из этого разрыва.
    const lastPackedByEmpDay = new Map<string, Date>();

    const out: StageDuration[] = [];
    for (const c of completes) {
      const stage = stageFromEventType(c.type);
      if (!stage) continue;
      if (!c.employeeId) continue;
      let acceptAt: Date | null = null;
      if (stage === 'PACKING') {
        const key = `${c.employeeId}|${toUtcDateKey(c.createdAt)}`;
        const prev = lastPackedByEmpDay.get(key) ?? null;
        // Обновляем курсор СЕЙЧАС, чтобы следующая упаковка опиралась
        // на текущий PACKED, а не на предыдущий.
        lastPackedByEmpDay.set(key, c.createdAt);
        acceptAt = computePackingAccept(prev, c.createdAt);
      } else {
        const wantedCategory = categoryForStage(stage);
        const passportScans = scansByPassport.get(c.passportId) ?? [];
        const accept = findLastBefore(
          passportScans,
          wantedCategory,
          c.createdAt,
        );
        if (!accept) continue;
        acceptAt = accept.createdAt;
      }
      if (!acceptAt) continue;
      const rawMs = c.createdAt.getTime() - acceptAt.getTime();
      if (rawMs <= 0) continue;
      const rawMinutes = Math.max(1, Math.ceil(rawMs / 60_000));
      const capped = rawMinutes > MAX_STAGE_MINUTES_PER_PASSPORT;
      const durationMinutes = capped
        ? MAX_STAGE_MINUTES_PER_PASSPORT
        : rawMinutes;
      out.push({
        passportId: c.passportId,
        employeeId: c.employeeId,
        stage,
        completedAt: c.createdAt,
        durationMinutes,
        rawDurationMinutes: rawMinutes,
        capped,
      });
    }
    return out;
  }

  /**
   * Длительности по одному паспорту. Удобно для drill-down/тестов.
   * Возвращает по одному элементу на каждую завершённую стадию (или
   * пусто, если стадия ещё не закончена).
   */
  async getForPassport(
    passportId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<StageDuration[]> {
    const events = await tx.passportEvent.findMany({
      where: {
        passportId,
        type: {
          in: [
            PassportEventType.OPERATION_SCAN,
            PassportEventType.QC_PASSED,
            PassportEventType.WTO_PASSED,
            PassportEventType.PACKED,
          ],
        },
      },
      include: {
        operation: { select: { category: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const scans: Array<{ createdAt: Date; category: OperationCategory }> = [];
    const out: StageDuration[] = [];
    // PACKED, к которому нет «предыдущего PACKED того же упаковщика
    // в эту же UTC-дату» в рамках одного паспорта по построению нет —
    // паспорт пакуется ровно один раз. Поэтому в getForPassport accept
    // упаковки = currentPacked − 1 минута (фолбек), cap-аем сверху.
    for (const e of events) {
      if (e.type === PassportEventType.OPERATION_SCAN) {
        if (!e.operation) continue;
        scans.push({ createdAt: e.createdAt, category: e.operation.category });
        continue;
      }
      const stage = stageFromEventType(e.type);
      if (!stage || !e.employeeId) continue;
      let acceptAt: Date | null = null;
      if (stage === 'PACKING') {
        acceptAt = computePackingAccept(null, e.createdAt);
      } else {
        const wantedCategory = categoryForStage(stage);
        const accept = findLastBefore(scans, wantedCategory, e.createdAt);
        if (!accept) continue;
        acceptAt = accept.createdAt;
      }
      if (!acceptAt) continue;
      const rawMs = e.createdAt.getTime() - acceptAt.getTime();
      if (rawMs <= 0) continue;
      const rawMinutes = Math.max(1, Math.ceil(rawMs / 60_000));
      const capped = rawMinutes > MAX_STAGE_MINUTES_PER_PASSPORT;
      out.push({
        passportId,
        employeeId: e.employeeId,
        stage,
        completedAt: e.createdAt,
        durationMinutes: capped
          ? MAX_STAGE_MINUTES_PER_PASSPORT
          : rawMinutes,
        rawDurationMinutes: rawMinutes,
        capped,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stageFromEventType(
  type: PassportEventType,
): StageDuration['stage'] | null {
  switch (type) {
    case PassportEventType.QC_PASSED:
      return 'QC';
    case PassportEventType.WTO_PASSED:
      return 'WTO';
    case PassportEventType.PACKED:
      return 'PACKING';
    default:
      return null;
  }
}

function categoryForStage(stage: StageDuration['stage']): OperationCategory {
  switch (stage) {
    case 'QC':
      return OperationCategory.QC;
    case 'WTO':
      return OperationCategory.IRONING;
    case 'PACKING':
      return OperationCategory.PACKING;
  }
}

function findLastBefore(
  scans: Array<{ createdAt: Date; category: OperationCategory }>,
  category: OperationCategory,
  before: Date,
): { createdAt: Date } | null {
  let best: { createdAt: Date } | null = null;
  for (const s of scans) {
    if (s.category !== category) continue;
    if (s.createdAt.getTime() >= before.getTime()) break;
    best = s;
  }
  return best;
}

/** UTC-дата `YYYY-MM-DD` для группировки PACKING-cursor-а. */
function toUtcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Accept-точка PACKING стадии. На MVP отдельного `OPERATION_SCAN` для
 * упаковки нет: считаем разрыв между двумя соседними `PACKED` того же
 * упаковщика в ту же UTC-дату — это и есть «время на одну упаковку».
 *
 *   prev  | результат
 *   null  | currentPacked − 1 минута (минимально учитываемый разрыв
 *           для самой первой упаковки в дате)
 *   есть  | max(prev, current − MAX_STAGE_MINUTES_PER_PASSPORT)
 *
 * Cap нужен потому, что между двумя соседними упаковками может
 * пройти час «бумажной волокиты», и тогда учитывать всё это как
 * упаковку — неправильно: столько бы съело весь оклад смены.
 */
function computePackingAccept(prev: Date | null, current: Date): Date {
  const capFloorMs =
    current.getTime() - MAX_STAGE_MINUTES_PER_PASSPORT * 60_000;
  if (!prev) {
    // Минимум 1 минута, но не больше cap (в любом случае cap > 1 мин).
    return new Date(current.getTime() - 60_000);
  }
  const prevMs = prev.getTime();
  return new Date(Math.max(prevMs, capFloorMs));
}
