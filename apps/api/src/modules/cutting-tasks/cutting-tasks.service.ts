import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  computeCuttingTotals,
  type CuttingTaskDetailDto,
  type CuttingTaskLayDto,
  type CuttingTaskSizeRowDto,
  type CuttingTaskStatus,
  type CuttingTaskSummaryDto,
  type OrderReadyForReleaseDto,
  type OrderReleaseStateDto,
  type ReleaseLayDto,
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
 * раскройщика: взять в работу, сохранить прогресс раскладов, завершить.
 *
 * Раскрой многораскладный: в одном заказе раскройщик делает несколько
 * раскладов (`CuttingTaskLay`), в каждом — свой набор выбранных размеров
 * с «на настиле» (`CuttingTaskLaySize`) и свои рулоны (`CuttingTaskRoll`).
 * План по размерам (`CuttingTaskSizeRow.qtyPlan`) — общий снимок заказа,
 * read-only.
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
    lays: {
      select: {
        laySizes: { select: { sizeId: true, perLayerQty: true } },
        rolls: { select: { layers: true } },
      },
    },
    _count: { select: { sizeRows: true, lays: true } },
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
        order: {
          select: {
            number: true,
            color: true,
            customer: true,
            // Ф3 «Расцветки»: расцветки заказа — источник выбора цвета
            // рулона в кабинете раскроя.
            variants: {
              orderBy: { ordinal: 'asc' },
              select: { id: true, ordinal: true, color: true },
            },
          },
        },
        assignedTo: { select: { fullName: true } },
        sizeRows: { orderBy: { sortOrder: 'asc' } },
        lays: {
          orderBy: { ordinal: 'asc' },
          include: {
            laySizes: { orderBy: { sortOrder: 'asc' } },
            rolls: {
              orderBy: { ordinal: 'asc' },
              include: { variant: { select: { color: true } } },
            },
          },
        },
        _count: { select: { sizeRows: true, lays: true } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();

    const sizeRows: CuttingTaskSizeRowDto[] = task.sizeRows.map((r) => ({
      id: r.id,
      sortOrder: r.sortOrder,
      sizeId: r.sizeId,
      sizeCodeSnapshot: r.sizeCodeSnapshot,
      qtyPlan: r.qtyPlan,
    }));
    const lays: CuttingTaskLayDto[] = task.lays.map((l) => ({
      id: l.id,
      ordinal: l.ordinal,
      sizes: l.laySizes.map((s) => ({
        sizeId: s.sizeId,
        sizeCodeSnapshot: s.sizeCodeSnapshot,
        sortOrder: s.sortOrder,
        perLayerQty: s.perLayerQty,
      })),
      rolls: l.rolls.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        layers: r.layers,
        variantId: r.variantId,
        variantColor: r.variant?.color ?? null,
      })),
    }));

    return {
      ...this.toSummary(task),
      orderCustomer: task.order?.customer ?? null,
      sizeRows,
      lays,
      variants: (task.order?.variants ?? []).map((v) => ({
        id: v.id,
        ordinal: v.ordinal,
        color: v.color,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // РУЛОННЫЙ ВЫПУСК (помощник раскройщика, CUTTER_ASSISTANT)
  // ---------------------------------------------------------------------------

  /**
   * Доска помощника `/work/cut-orders`: заказы, по которым раскрой
   * завершён (`CuttingTask = DONE`) и можно выпускать паспорта.
   *
   * `status` строки: `DONE`, если выпущены все ожидаемые тройки
   * `(расклад, размер, рулон)` (метка «Завершено»), иначе `NEW`
   * (подсветка «новый»). Ожидаемая тройка — в раскладе размер с
   * `perLayerQty > 0` × рулон с `layers > 0`. Выпущенная — наличие
   * non-CANCELLED паспорта с соответствующими `cuttingLayOrdinal` +
   * `rollOrdinal`.
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
        lays: {
          select: {
            ordinal: true,
            laySizes: { select: { sizeId: true, perLayerQty: true } },
            rolls: { select: { ordinal: true, layers: true } },
          },
        },
      },
    });
    if (tasks.length === 0) return [];

    // Выпущенные тройки `(layOrdinal, sizeId, rollOrdinal)` по всем
    // заказам одним запросом, чтобы не делать N+1.
    const orderIds = tasks.map((t) => t.orderId);
    const released = await this.prisma.passport.findMany({
      where: {
        orderId: { in: orderIds },
        status: { not: 'CANCELLED' },
        rollOrdinal: { not: null },
        cuttingLayOrdinal: { not: null },
      },
      select: {
        orderId: true,
        sizeId: true,
        rollOrdinal: true,
        cuttingLayOrdinal: true,
      },
    });
    const releasedByOrder = new Map<string, Set<string>>();
    for (const p of released) {
      const set = releasedByOrder.get(p.orderId) ?? new Set<string>();
      set.add(`${p.cuttingLayOrdinal}:${p.sizeId}:${p.rollOrdinal}`);
      releasedByOrder.set(p.orderId, set);
    }

    return tasks.map((t) => {
      const releasedSet = releasedByOrder.get(t.orderId) ?? new Set<string>();
      let totalPairs = 0;
      let releasedPairs = 0;
      for (const lay of t.lays) {
        const sizes = lay.laySizes.filter((s) => s.sizeId && s.perLayerQty > 0);
        const rolls = lay.rolls.filter((r) => r.layers > 0);
        for (const s of sizes) {
          for (const roll of rolls) {
            totalPairs += 1;
            if (releasedSet.has(`${lay.ordinal}:${s.sizeId}:${roll.ordinal}`)) {
              releasedPairs += 1;
            }
          }
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
   * ветка помощника). Расклады (с размерами и рулонами) из завершённой
   * задачи раскройщика и карта уже выпущенных троек `(расклад, размер,
   * рулон)`.
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
        sizeRows: { select: { sizeId: true, qtyPlan: true } },
        lays: {
          orderBy: { ordinal: 'asc' },
          include: {
            laySizes: { orderBy: { sortOrder: 'asc' } },
            rolls: {
              orderBy: { ordinal: 'asc' },
              include: { variant: { select: { color: true } } },
            },
          },
        },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();

    // План по размеру — общий для всех раскладов (снимок заказа).
    const planBySize = new Map<string, number>();
    for (const r of task.sizeRows) {
      if (r.sizeId) planBySize.set(r.sizeId, r.qtyPlan);
    }

    const released = await this.prisma.passport.findMany({
      where: {
        orderId,
        status: { not: 'CANCELLED' },
        rollOrdinal: { not: null },
        cuttingLayOrdinal: { not: null },
      },
      select: {
        id: true,
        number: true,
        sizeId: true,
        rollOrdinal: true,
        cuttingLayOrdinal: true,
      },
    });

    const lays: ReleaseLayDto[] = task.lays.map((l) => ({
      ordinal: l.ordinal,
      sizes: l.laySizes
        .filter((s) => s.sizeId)
        .map((s) => ({
          sizeId: s.sizeId as string,
          sizeCode: s.sizeCodeSnapshot,
          sortOrder: s.sortOrder,
          perLayerQty: s.perLayerQty,
          qtyPlan: planBySize.get(s.sizeId as string) ?? 0,
        })),
      rolls: l.rolls
        .filter((r) => r.layers > 0)
        .map((r) => ({
          ordinal: r.ordinal,
          layers: r.layers,
          variantId: r.variantId,
          variantColor: r.variant?.color ?? null,
        })),
    }));

    return {
      orderId: task.orderId,
      orderNumber: task.order?.number ?? '—',
      productId: task.order?.items[0]?.productId ?? null,
      productName: task.order?.items[0]?.product?.name ?? '—',
      color: task.order?.color ?? '—',
      cuttingTaskStatus: task.status as CuttingTaskStatus,
      lays,
      released: released.map((p) => ({
        layOrdinal: p.cuttingLayOrdinal as number,
        sizeId: p.sizeId,
        ordinal: p.rollOrdinal as number,
        passportId: p.id,
        passportNumber: p.number,
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
   * Сохранить прогресс (автосейв из формы): полностью перезаписать набор
   * раскладов задачи. Требует статус `IN_PROGRESS`.
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
   * Общая запись прогресса. Полностью заменяет набор раскладов (replace,
   * не diff): индекс расклада в `dto.lays` → `ordinal` (1-based).
   * `markDone` дополнительно переводит задачу в `DONE`. Всё в одной
   * транзакции: либо прогресс сохранён целиком (и, если просили, статус
   * сменён), либо ничего.
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
        sizeRows: {
          select: { sizeId: true, sizeCodeSnapshot: true, sortOrder: true },
        },
        // Ф3 «Расцветки»: допустимые расцветки заказа — whitelist для
        // `roll.variantId` (защита от подделки чужого id).
        order: { select: { variants: { select: { id: true } } } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();
    if (opts.requireInProgress && task.status !== 'IN_PROGRESS') {
      throw new CuttingTaskNotInProgressException();
    }

    const variantIdSet = new Set(
      (task.order?.variants ?? []).map((v) => v.id),
    );

    // Снимок плана задачи — whitelist допустимых размеров + источник
    // sizeCodeSnapshot/sortOrder для строк расклада. Размер из payload,
    // которого нет в плане задачи, отвергаем (защита от подделки).
    const sizeMeta = new Map<
      string,
      { sizeCodeSnapshot: string; sortOrder: number }
    >();
    for (const r of task.sizeRows) {
      if (r.sizeId) {
        sizeMeta.set(r.sizeId, {
          sizeCodeSnapshot: r.sizeCodeSnapshot,
          sortOrder: r.sortOrder,
        });
      }
    }
    for (const lay of dto.lays) {
      for (const ls of lay.laySizes) {
        if (!sizeMeta.has(ls.sizeId)) {
          throw new CuttingTaskPayloadInvalidException(
            `Размер ${ls.sizeId} не относится к этой задаче`,
          );
        }
      }
      // Ф3: расцветка рулона должна принадлежать заказу задачи.
      for (const r of lay.rolls) {
        if (r.variantId && !variantIdSet.has(r.variantId)) {
          throw new CuttingTaskPayloadInvalidException(
            `Расцветка ${r.variantId} не относится к этому заказу`,
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Полная замена раскладов: каскад снесёт laySizes и rolls.
      await tx.cuttingTaskLay.deleteMany({ where: { taskId: id } });

      for (let i = 0; i < dto.lays.length; i += 1) {
        const lay = dto.lays[i]!;
        await tx.cuttingTaskLay.create({
          data: {
            taskId: id,
            ordinal: i + 1,
            laySizes: {
              createMany: {
                data: lay.laySizes.map((ls) => {
                  const meta = sizeMeta.get(ls.sizeId)!;
                  return {
                    sizeId: ls.sizeId,
                    sizeCodeSnapshot: meta.sizeCodeSnapshot,
                    sortOrder: meta.sortOrder,
                    perLayerQty: ls.perLayerQty,
                  };
                }),
              },
            },
            rolls: {
              createMany: {
                data: lay.rolls.map((r) => ({
                  ordinal: r.ordinal,
                  layers: r.layers,
                  variantId: r.variantId ?? null,
                })),
              },
            },
          },
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
    lays: Array<{
      laySizes: Array<{ sizeId: string | null; perLayerQty: number }>;
      rolls: Array<{ layers: number }>;
    }>;
    _count: { sizeRows: number; lays: number };
  }): CuttingTaskSummaryDto {
    const { totalLayers, rollsCount } = computeCuttingTotals(t.lays);
    return {
      id: t.id,
      orderId: t.orderId,
      orderNumber: t.order?.number ?? '—',
      orderColor: t.order?.color ?? null,
      status: t.status as CuttingTaskStatus,
      assignedToName: t.assignedTo?.fullName ?? null,
      sizeRowsCount: t._count.sizeRows,
      laysCount: t._count.lays,
      rollsCount,
      totalLayers,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      startedAt: t.startedAt ? t.startedAt.toISOString() : null,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    };
  }
}
