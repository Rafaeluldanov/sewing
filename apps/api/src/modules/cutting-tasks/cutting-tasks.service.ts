import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  computeCuttingTotals,
  type CuttingTaskDetailDto,
  type CuttingTaskRollDto,
  type CuttingTaskSizeRowDto,
  type CuttingTaskStatus,
  type CuttingTaskSummaryDto,
  type OrderReadyForReleaseDto,
  type OrderReleaseStateDto,
  type SaveCuttingTaskProgressDto,
} from '@sewing/shared/cutting-tasks';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CuttingTaskInvalidTransitionException,
  CuttingTaskNotFoundException,
  CuttingTaskNotInProgressException,
  CuttingTaskPayloadInvalidException,
} from '../../common/errors.js';

/**
 * Сервис «Кабинет раскройщика» (`CuttingTask`, роль `CUTTER`).
 *
 * Создание задачи живёт в `OrdersService.start()` (в той же транзакции,
 * что перевод заказа в `IN_PRODUCTION`) — здесь только чтение и действия
 * раскройщика: взять в работу, сохранить прогресс настила, завершить.
 *
 * Очередь общая (см. ТЗ кабинета): задачу видит и берёт любой
 * раскройщик; `assignedToId` фиксирует, кто фактически взял (для аудита
 * и будущей передачи данных помощнику раскройщика), но владение НЕ
 * энфорсится — править прогресс может любой раскройщик/менеджер.
 */
@Injectable()
export class CuttingTasksService {
  private readonly logger = new Logger(CuttingTasksService.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly summaryInclude = {
    order: { select: { number: true, color: true, customer: true } },
    assignedTo: { select: { fullName: true } },
    sizeRows: { select: { sizeId: true, perLayerQty: true } },
    rolls: { select: { layers: true } },
    _count: { select: { sizeRows: true, rolls: true } },
  } satisfies Prisma.CuttingTaskInclude;

  // ---------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------

  /**
   * Список задач для кабинета раскройщика. Показываем всё, кроме
   * `CANCELLED`: активные (`NEW`/`IN_PROGRESS`) — для работы, недавние
   * `DONE` — как короткая история. Делёж на секции — на клиенте.
   */
  async listForCabinet(): Promise<CuttingTaskSummaryDto[]> {
    const tasks = await this.prisma.cuttingTask.findMany({
      where: { status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: this.summaryInclude,
    });
    return tasks.map((t) => this.toSummary(t));
  }

  async getOne(id: string): Promise<CuttingTaskDetailDto> {
    const task = await this.prisma.cuttingTask.findUnique({
      where: { id },
      include: {
        order: { select: { number: true, color: true, customer: true } },
        assignedTo: { select: { fullName: true } },
        sizeRows: { orderBy: { sortOrder: 'asc' } },
        rolls: { orderBy: { ordinal: 'asc' } },
        _count: { select: { sizeRows: true, rolls: true } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();

    const sizeRows: CuttingTaskSizeRowDto[] = task.sizeRows.map((r) => ({
      id: r.id,
      sortOrder: r.sortOrder,
      sizeId: r.sizeId,
      sizeCodeSnapshot: r.sizeCodeSnapshot,
      qtyPlan: r.qtyPlan,
      perLayerQty: r.perLayerQty,
    }));
    const rolls: CuttingTaskRollDto[] = task.rolls.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      layers: r.layers,
    }));

    return {
      ...this.toSummary(task),
      orderCustomer: task.order?.customer ?? null,
      sizeRows,
      rolls,
    };
  }

  // ---------------------------------------------------------------------------
  // РУЛОННЫЙ ВЫПУСК (помощник раскройщика, CUTTER_ASSISTANT)
  // ---------------------------------------------------------------------------

  /**
   * Доска помощника `/work/cut-orders`: заказы, по которым раскрой
   * завершён (`CuttingTask = DONE`) и можно выпускать паспорта.
   *
   * `status` строки: `DONE`, если выпущены все ожидаемые пары
   * `(размер, рулон)` (метка «Завершено»), иначе `NEW` (подсветка
   * «новый»). Ожидаемая пара — размер с `perLayerQty > 0` × рулон с
   * `layers > 0`. Выпущенная пара — наличие non-CANCELLED паспорта с
   * соответствующим `rollOrdinal`.
   */
  async listReadyForRelease(): Promise<OrderReadyForReleaseDto[]> {
    const tasks = await this.prisma.cuttingTask.findMany({
      where: { status: 'DONE' },
      orderBy: { completedAt: 'desc' },
      take: 200,
      include: {
        order: {
          select: {
            number: true,
            color: true,
            items: {
              take: 1,
              select: { product: { select: { name: true } } },
            },
          },
        },
        sizeRows: { select: { sizeId: true, perLayerQty: true } },
        rolls: { select: { ordinal: true, layers: true } },
      },
    });
    if (tasks.length === 0) return [];

    // Выпущенные пары `(sizeId, rollOrdinal)` по всем заказам одним
    // запросом, чтобы не делать N+1.
    const orderIds = tasks.map((t) => t.orderId);
    const released = await this.prisma.passport.findMany({
      where: {
        orderId: { in: orderIds },
        status: { not: 'CANCELLED' },
        rollOrdinal: { not: null },
      },
      select: { orderId: true, sizeId: true, rollOrdinal: true },
    });
    const releasedByOrder = new Map<string, Set<string>>();
    for (const p of released) {
      const set = releasedByOrder.get(p.orderId) ?? new Set<string>();
      set.add(`${p.sizeId}:${p.rollOrdinal}`);
      releasedByOrder.set(p.orderId, set);
    }

    return tasks.map((t) => {
      const sizes = t.sizeRows.filter((r) => r.sizeId && r.perLayerQty > 0);
      const rolls = t.rolls.filter((r) => r.layers > 0);
      const releasedSet = releasedByOrder.get(t.orderId) ?? new Set<string>();
      let totalPairs = 0;
      let releasedPairs = 0;
      for (const s of sizes) {
        for (const roll of rolls) {
          totalPairs += 1;
          if (releasedSet.has(`${s.sizeId}:${roll.ordinal}`)) releasedPairs += 1;
        }
      }
      const status: OrderReadyForReleaseDto['status'] =
        totalPairs > 0 && releasedPairs >= totalPairs ? 'DONE' : 'NEW';
      return {
        orderId: t.orderId,
        orderNumber: t.order?.number ?? '—',
        productName: t.order?.items[0]?.product?.name ?? '—',
        color: t.order?.color ?? '—',
        totalPairs,
        releasedPairs,
        status,
      };
    });
  }

  /**
   * Данные для экрана выпуска по рулонам (`/orders/:id/passports/new`,
   * ветка помощника). Размеры + рулоны из завершённой задачи раскройщика
   * и карта уже выпущенных пар `(размер, рулон)`.
   */
  async getReleaseState(orderId: string): Promise<OrderReleaseStateDto> {
    const task = await this.prisma.cuttingTask.findUnique({
      where: { orderId },
      include: {
        order: {
          select: {
            number: true,
            color: true,
            items: {
              take: 1,
              select: { productId: true, product: { select: { name: true } } },
            },
          },
        },
        sizeRows: { orderBy: { sortOrder: 'asc' } },
        rolls: { orderBy: { ordinal: 'asc' } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();

    const released = await this.prisma.passport.findMany({
      where: {
        orderId,
        status: { not: 'CANCELLED' },
        rollOrdinal: { not: null },
      },
      select: { sizeId: true, rollOrdinal: true },
    });

    return {
      orderId: task.orderId,
      orderNumber: task.order?.number ?? '—',
      productId: task.order?.items[0]?.productId ?? null,
      productName: task.order?.items[0]?.product?.name ?? '—',
      color: task.order?.color ?? '—',
      cuttingTaskStatus: task.status as CuttingTaskStatus,
      sizes: task.sizeRows
        .filter((r) => r.sizeId)
        .map((r) => ({
          sizeId: r.sizeId as string,
          sizeCode: r.sizeCodeSnapshot,
          sortOrder: r.sortOrder,
          perLayerQty: r.perLayerQty,
          qtyPlan: r.qtyPlan,
        })),
      rolls: task.rolls
        .filter((r) => r.layers > 0)
        .map((r) => ({ ordinal: r.ordinal, layers: r.layers })),
      released: released.map((p) => ({
        sizeId: p.sizeId,
        ordinal: p.rollOrdinal as number,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // ACTIONS
  // ---------------------------------------------------------------------------

  /**
   * «Принять задание» — `NEW` → `IN_PROGRESS`, фиксируем раскройщика и
   * `startedAt`. Идемпотентно: повторный вызов на `IN_PROGRESS` просто
   * возвращает карточку. `DONE`/`CANCELLED` — ошибка перехода.
   */
  async start(id: string, employeeId: string): Promise<CuttingTaskDetailDto> {
    const existing = await this.prisma.cuttingTask.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new CuttingTaskNotFoundException();

    if (existing.status === 'DONE' || existing.status === 'CANCELLED') {
      throw new CuttingTaskInvalidTransitionException(
        existing.status === 'DONE'
          ? 'Раскрой уже завершён'
          : 'Задача отменена',
      );
    }

    if (existing.status === 'NEW') {
      await this.prisma.cuttingTask.update({
        where: { id },
        data: {
          status: 'IN_PROGRESS',
          assignedToId: employeeId,
          startedAt: new Date(),
        },
      });
      this.logger.log(
        `event=cutting-task.started taskId=${id} by=${employeeId}`,
      );
    }
    return this.getOne(id);
  }

  /**
   * Сохранить прогресс настила (автосейв из формы): перезаписать
   * `perLayerQty` строк-размеров и весь набор рулонов. Требует статус
   * `IN_PROGRESS`.
   */
  async saveProgress(
    id: string,
    dto: SaveCuttingTaskProgressDto,
  ): Promise<CuttingTaskDetailDto> {
    await this.persistProgress(id, dto, { requireInProgress: true });
    return this.getOne(id);
  }

  /**
   * «Раскрой завершён» — сохранить финальный прогресс и перевести
   * `IN_PROGRESS` → `DONE` (+ `completedAt`). На этом этапе паспорта НЕ
   * трогаем: данные дальше пойдут в кабинет помощника раскройщика
   * отдельным шагом.
   */
  async complete(
    id: string,
    dto: SaveCuttingTaskProgressDto,
  ): Promise<CuttingTaskDetailDto> {
    await this.persistProgress(id, dto, {
      requireInProgress: true,
      markDone: true,
    });
    this.logger.log(`event=cutting-task.completed taskId=${id}`);
    return this.getOne(id);
  }

  /**
   * Общая запись прогресса. `markDone` дополнительно переводит задачу в
   * `DONE`. Всё в одной транзакции: либо прогресс сохранён целиком (и,
   * если просили, статус сменён), либо ничего.
   */
  private async persistProgress(
    id: string,
    dto: SaveCuttingTaskProgressDto,
    opts: { requireInProgress: boolean; markDone?: boolean },
  ): Promise<void> {
    const task = await this.prisma.cuttingTask.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        sizeRows: { select: { id: true, sizeId: true } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();
    if (opts.requireInProgress && task.status !== 'IN_PROGRESS') {
      throw new CuttingTaskNotInProgressException();
    }

    // Валидируем sizeId из payload по whitelist реальных строк задачи —
    // защита от подделки. `perLayerQty` пишем только в свои строки.
    const sizeIdToRowId = new Map<string, string>();
    for (const r of task.sizeRows) {
      if (r.sizeId) sizeIdToRowId.set(r.sizeId, r.id);
    }
    for (const sr of dto.sizeRows) {
      if (!sizeIdToRowId.has(sr.sizeId)) {
        throw new CuttingTaskPayloadInvalidException(
          `Размер ${sr.sizeId} не относится к этой задаче`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const sr of dto.sizeRows) {
        await tx.cuttingTaskSizeRow.update({
          where: { id: sizeIdToRowId.get(sr.sizeId)! },
          data: { perLayerQty: sr.perLayerQty },
        });
      }

      // Рулоны — полная замена (replace, не diff): проще и совпадает с
      // UX «таблица рулонов целиком приходит из формы».
      await tx.cuttingTaskRoll.deleteMany({ where: { taskId: id } });
      if (dto.rolls.length > 0) {
        await tx.cuttingTaskRoll.createMany({
          data: dto.rolls.map((r) => ({
            taskId: id,
            ordinal: r.ordinal,
            layers: r.layers,
          })),
        });
      }

      if (opts.markDone) {
        await tx.cuttingTask.update({
          where: { id },
          data: { status: 'DONE', completedAt: new Date() },
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // INTERNAL
  // ---------------------------------------------------------------------------

  private toSummary(t: {
    id: string;
    orderId: string;
    status: string;
    assignedToId: string | null;
    createdAt: Date;
    updatedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    order: { number: string; color: string | null } | null;
    assignedTo: { fullName: string } | null;
    sizeRows: Array<{ sizeId: string | null; perLayerQty: number }>;
    rolls: Array<{ layers: number }>;
    _count: { sizeRows: number; rolls: number };
  }): CuttingTaskSummaryDto {
    const { totalLayers } = computeCuttingTotals(t.sizeRows, t.rolls);
    return {
      id: t.id,
      orderId: t.orderId,
      orderNumber: t.order?.number ?? '—',
      orderColor: t.order?.color ?? null,
      status: t.status as CuttingTaskStatus,
      assignedToName: t.assignedTo?.fullName ?? null,
      sizeRowsCount: t._count.sizeRows,
      rollsCount: t._count.rolls,
      totalLayers,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      startedAt: t.startedAt ? t.startedAt.toISOString() : null,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    };
  }
}
