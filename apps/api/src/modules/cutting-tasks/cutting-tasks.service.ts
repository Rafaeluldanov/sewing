import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CuttingTaskErpRollDto,
  CUTTING_LAY_BLOCKING_PASSPORTS_SHOWN,
  computeCuttingTotals,
  listCuttingCompletionProblems,
  listLayCompletionProblems,
  type CuttingTaskDetailDto,
  type CuttingTaskLayDto,
  type CuttingTaskLayInputDto,
  type CuttingTaskSizeRowDto,
  type CuttingTaskStatus,
  type CuttingTaskSummaryDto,
  type OrderReadyForReleaseDto,
  type OrderReleaseQueueStatus,
  type OrderReleaseStateDto,
  type ReleaseLayDto,
  type SaveCuttingTaskProgressDto,
} from '@sewing/shared/cutting-tasks';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CuttingLayCompletionIncompleteException,
  CuttingLayHasPassportsException,
  CuttingLayLockedException,
  CuttingLayNotFoundException,
  CuttingTaskCompletionIncompleteException,
  CuttingTaskInvalidTransitionException,
  CuttingTaskNotFoundException,
  CuttingTaskNotInProgressException,
  CuttingTaskPayloadInvalidException,
} from '../../common/errors.js';
import { countReleasePairs } from '../../common/cutting-release.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Паспорт, выпущенный по раскладу, с признаком «уже ушёл в работу» —
 * основа гейта правки закрытого расклада (`reopenLay`).
 */
interface LayPassportState {
  id: string;
  number: string;
  /** `Passport.cuttingLayOrdinal` — номер расклада, из которого выпущен. */
  layOrdinal: number;
  sizeId: string;
  /** `Passport.rollOrdinal`; `null` у паспортов не рулонного выпуска. */
  rollOrdinal: number | null;
  /** Штук в паспорте — в `AuditLog` при удалении ради правки настила. */
  qtyCut: number;
  /**
   * Паспорт двинулся с кроя: сменил статус, лёг в ячейку, получил
   * событие кроме `CREATED`, попал в коробку или в проведённое
   * списание материалов. Такой паспорт удалять нельзя — за ним уже
   * стоят движения склада и производства.
   *
   * Условие «свежести» (`moved === false`) намеренно совпадает с
   * `PassportsService.editableBlockReason`: паспорт, который автор мог
   * бы удалить сам на «Выпущенных паспортах», снимается и открытием
   * расклада.
   */
  moved: boolean;
}

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
            completedBy: { select: { fullName: true } },
          },
        },
        _count: { select: { sizeRows: true, lays: true } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();

    // Частичное завершение: сколько паспортов уже выпущено по каждому
    // раскладу — подпись «выпущено 2 из 8». Плюс правка закрытого
    // расклада: сколько паспортов снимется при «Открыть расклад» и какие
    // из них уже ушли в работу (тогда открыть нельзя вовсе).
    const layPassports = await this.loadLayPassports(task.orderId);
    const releasedSet = new Set(
      layPassports
        .filter((p) => p.rollOrdinal != null)
        .map((p) => `${p.layOrdinal}:${p.sizeId}:${p.rollOrdinal}`),
    );
    const passportsByLay = new Map<number, LayPassportState[]>();
    for (const p of layPassports) {
      const list = passportsByLay.get(p.layOrdinal) ?? [];
      list.push(p);
      passportsByLay.set(p.layOrdinal, list);
    }

    const sizeRows: CuttingTaskSizeRowDto[] = task.sizeRows.map((r) => ({
      id: r.id,
      sortOrder: r.sortOrder,
      sizeId: r.sizeId,
      sizeCodeSnapshot: r.sizeCodeSnapshot,
      qtyPlan: r.qtyPlan,
    }));
    const erpRolls = await this.listErpRolls(task.orderId);

    const lays: CuttingTaskLayDto[] = task.lays.map((l) => {
      // Единица счёта — паспорт: тройка «расклад × размер × рулон» с qty > 0
      // даёт ровно один паспорт (тот же алгоритм, что в очереди выпуска).
      const { totalPairs, releasedPairs } = countReleasePairs(
        [
          {
            ordinal: l.ordinal,
            laySizes: l.laySizes.map((s) => ({
              sizeId: s.sizeId,
              perLayerQty: s.perLayerQty,
            })),
            rolls: l.rolls.map((r) => ({ ordinal: r.ordinal, layers: r.layers })),
          },
        ],
        releasedSet,
      );
      const own = passportsByLay.get(l.ordinal) ?? [];
      const blocked = own.filter((p) => p.moved);
      return {
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
          erpSeriesId: r.erpSeriesId ?? null,
          erpRollLabel: r.erpRollLabel ?? null,
        })),
        completedAt: l.completedAt ? l.completedAt.toISOString() : null,
        completedByName: l.completedBy?.fullName ?? null,
        totalPassports: totalPairs,
        releasedPassports: releasedPairs,
        reopenDeletesPassports: own.length - blocked.length,
        reopenBlockedPassports: blocked
          .slice(0, CUTTING_LAY_BLOCKING_PASSPORTS_SHOWN)
          .map((p) => p.number),
        reopenBlockedTotal: blocked.length,
      };
    });

    return {
      ...this.toSummary(task),
      orderCustomer: task.order?.customer ?? null,
      sizeRows,
      lays,
      erpRolls,
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
      // Частичное завершение: в очередь попадает заказ, у которого закрыт
      // ХОТЯ БЫ ОДИН расклад — не дожидаясь `status = DONE` по всей задаче.
      // Плюс задачи, завершённые ДО фичи: у их раскладов `completedAt`
      // пустой, готовность несёт сама задача (обратная совместимость).
      where: {
        OR: [
          { status: 'DONE' },
          {
            status: { notIn: ['CANCELLED'] },
            lays: { some: { completedAt: { not: null } } },
          },
        ],
      },
      orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
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
            completedAt: true,
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
      const cuttingDone = t.status === 'DONE';
      // Считаем только по ЗАКРЫТЫМ раскладам: открытый ещё может измениться,
      // обещать по нему паспорта нельзя. У задач, завершённых до фичи,
      // `completedAt` пустой — там источник готовности сама задача.
      const countableLays = cuttingDone
        ? t.lays
        : t.lays.filter((l) => l.completedAt);
      const { totalPairs, releasedPairs } = countReleasePairs(
        countableLays,
        releasedSet,
      );
      const laysClosed = t.lays.filter((l) => l.completedAt).length;
      const allReleased = totalPairs > 0 && releasedPairs >= totalPairs;
      // NEW — есть что печатать; WAITING — по закрытым всё выпущено, но
      // раскрой продолжается (заказ вернётся сам); DONE — раскрой завершён
      // и выпущено всё. Без WAITING заказ с настилающимся раскладом
      // помечался бы зелёным «Завершено» и выпадал из внимания.
      const status: OrderReleaseQueueStatus = allReleased
        ? cuttingDone
          ? 'DONE'
          : 'WAITING'
        : 'NEW';
      return {
        orderId: t.orderId,
        orderNumber: t.order?.number ?? '—',
        productName: t.order?.items[0]?.product?.name ?? '—',
        color: t.order?.color ?? '—',
        totalPassports: totalPairs,
        releasedPassports: releasedPairs,
        laysTotal: t.lays.length,
        laysClosed: cuttingDone ? t.lays.length : laysClosed,
        cuttingInProgress: !cuttingDone,
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
    const cuttingDone = task.status === 'DONE';

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
      // Частичное завершение: форма выпуска гасит расклады, которые ещё
      // настилаются. Для задач, завершённых до фичи, `completedAt` пустой —
      // подставляем момент завершения задачи, иначе UI счёл бы их открытыми
      // и выпуск по историческим заказам стал бы недоступен.
      completedAt: l.completedAt
        ? l.completedAt.toISOString()
        : cuttingDone
          ? // Legacy: у задач, завершённых ДО фичи, у раскладов
            // `completedAt` пустой (backfill не делали), а гейт выпуска на
            // backend их пропускает по `task.status = DONE`. Если бы DTO
            // отдал здесь `null`, UI счёл бы такой расклад открытым и
            // спрятал бы его — выпуск по всем историческим заказам
            // «сломался» бы только в интерфейсе. `updatedAt` — страховка
            // на случай `DONE` без `completedAt` в старых данных.
            (task.completedAt ?? task.updatedAt).toISOString()
          : null,
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
   * Сохранить прогресс формы раскроя — merge раскладов по `ordinal`
   * (см. `persistProgress`). Требует статус `IN_PROGRESS`.
   */
  async saveProgress(
    id: string,
    dto: SaveCuttingTaskProgressDto,
  ): Promise<CuttingTaskDetailDto> {
    await this.persistProgress(id, dto, { requireInProgress: true });
    return this.getOne(id);
  }

  /**
   * «Раскрой завершён» — сохранить финальный прогресс, закрыть все ещё
   * открытые расклады и перевести `IN_PROGRESS` → `DONE` (+ `completedAt`).
   * На этом этапе паспорта НЕ трогаем: выпуск — отдельный шаг (и он мог
   * уже частично пройти по закрытым раскладам).
   */
  async complete(
    id: string,
    dto: SaveCuttingTaskProgressDto,
    employeeId?: string | null,
  ): Promise<CuttingTaskDetailDto> {
    await this.persistProgress(id, dto, {
      requireInProgress: true,
      markDone: true,
      employeeId: employeeId ?? null,
    });
    this.logger.log(`event=cutting-task.completed taskId=${id}`);
    return this.getOne(id);
  }

  /**
   * Общая запись прогресса — **merge по `ordinal`**, а не replace.
   *
   * Почему не replace (как было): раньше сохранение делало `deleteMany` по
   * всем раскладам и создавало их заново с `ordinal = индекс + 1`. С
   * появлением частичного завершения так нельзя — `Passport.cuttingLayOrdinal`
   * ссылается на номер расклада, и любой автосейв (а он идёт по таймеру)
   * пересоздал бы расклады: закрытый настил либо исчез бы, либо сменил
   * номер, а выпущенные по нему паспорта указывали бы на чужой расклад.
   *
   * Правила merge:
   *   - элемент payload с `ordinal` существующего расклада → обновляем
   *     этот расклад (его размеры и рулоны переписываются целиком);
   *   - элемент без `ordinal` → НОВЫЙ расклад, номер = max(ordinal) + 1
   *     (append-only, номера никогда не переиспользуются);
   *   - открытый расклад удаляется, ТОЛЬКО если его номер пришёл в
   *     `removedOrdinals` («✕ Удалить расклад»); просто отсутствие
   *     расклада в payload — не повод его сносить (см. ниже);
   *   - ЗАКРЫТЫЙ расклад (`completedAt != null`) неприкосновенен: его
   *     нельзя ни изменить, ни удалить — `CUTTING_LAY_LOCKED`. Отсутствие
   *     закрытого расклада в payload игнорируем (форма могла его вообще
   *     не присылать, т.к. рисует read-only).
   *
   * `markDone` дополнительно закрывает все ещё открытые расклады и
   * переводит задачу в `DONE`. Всё в одной транзакции: либо прогресс
   * сохранён целиком (и, если просили, статус сменён), либо ничего.
   */
  /**
   * Рулоны ERP, доступные для настила по заказу: по материалам заказа под ERP
   * (`erpNomenclatureId/erpCharacteristicId`) — строки зеркала остатка ERP с рулоном.
   */
  async listErpRolls(orderId: string): Promise<CuttingTaskErpRollDto[]> {
    const needs = await this.prisma.workshopNeed.findMany({
      where: {
        orderId,
        status: { not: 'CANCELLED' },
        erpManagedAt: { not: null },
        erpNomenclatureId: { not: null },
      },
      select: { erpNomenclatureId: true, erpCharacteristicId: true, description: true },
    });
    if (needs.length === 0) return [];
    const out: CuttingTaskErpRollDto[] = [];
    const seen = new Set<string>();
    for (const n of needs) {
      const rows = await this.prisma.erpShopStock.findMany({
        where: {
          erpProductId: n.erpNomenclatureId!,
          erpCharacteristicId: n.erpCharacteristicId ?? null,
          erpSeriesId: { not: null },
          qty: { gt: 0 },
        },
        orderBy: [{ rollNumber: 'asc' }],
      });
      for (const r of rows) {
        if (!r.erpSeriesId || seen.has(r.erpSeriesId)) continue;
        seen.add(r.erpSeriesId);
        const bins = Array.isArray(r.bins) ? (r.bins as Record<string, unknown>[]) : [];
        const bits = [
          r.rollNumber ? `№ ${r.rollNumber}` : null,
          r.shade,
          r.widthCm ? `${r.widthCm} см` : null,
          r.densityGsm ? `${r.densityGsm} г/м²` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        out.push({
          seriesId: r.erpSeriesId,
          label: `${r.erpProductName}${bits ? ` (${bits})` : ''}`,
          productName: r.erpProductName,
          qty: r.qty.toString(),
          unit: r.unit,
          bins: bins.map((b) => String(b['bin_code'] ?? '')).filter(Boolean),
        });
      }
    }
    return out;
  }

  private async persistProgress(
    id: string,
    dto: SaveCuttingTaskProgressDto,
    opts: {
      requireInProgress: boolean;
      markDone?: boolean;
      /** Кто нажал «Раскрой завершён» — уходит в `completedById` раскладов. */
      employeeId?: string | null;
    },
  ): Promise<void> {
    const task = await this.prisma.cuttingTask.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        sizeRows: {
          select: { sizeId: true, sizeCodeSnapshot: true, sortOrder: true },
        },
        // Частичное завершение: закрытые расклады защищаем от перезаписи,
        // а `ordinal` новых считаем от максимума (append-only).
        lays: { select: { id: true, ordinal: true, completedAt: true } },
        // Ф3 «Расцветки»: допустимые расцветки заказа — whitelist для
        // `roll.variantId` (защита от подделки чужого id).
        order: { select: { variants: { select: { id: true } } } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();
    if (opts.requireInProgress && task.status !== 'IN_PROGRESS') {
      throw new CuttingTaskNotInProgressException();
    }

    const layByOrdinal = new Map(task.lays.map((l) => [l.ordinal, l]));
    // Разбираем payload на «обновить существующий» / «создать новый» и
    // сразу режем попытки тронуть закрытый расклад.
    const updates: Array<{ layId: string; ordinal: number; lay: CuttingTaskLayInputDto }> = [];
    const creates: CuttingTaskLayInputDto[] = [];
    for (const lay of dto.lays) {
      if (lay.ordinal == null) {
        creates.push(lay);
        continue;
      }
      const existing = layByOrdinal.get(lay.ordinal);
      if (!existing) {
        // Клиент прислал номер, которого в задаче нет. Не создаём «дырку»
        // с чужим номером — считаем это новым раскладом в конце.
        creates.push(lay);
        continue;
      }
      if (existing.completedAt) {
        throw new CuttingLayLockedException(lay.ordinal);
      }
      updates.push({ layId: existing.id, ordinal: lay.ordinal, lay });
    }
    // Удаляем только то, что раскройщик снёс ЯВНО («✕ Удалить расклад»).
    //
    // Было (до 10.08.2026): удалялся любой открытый расклад, которого нет
    // в payload. Это ставило сохранность настила в зависимость от того,
    // насколько локальный стейт формы совпал с БД, — и на прод-заказе
    // 02-00013 первое же «Сохранить» после «Открыть расклад» стёрло
    // расклад (форма всё ещё считала его закрытым, а закрытые она не
    // присылает). Теперь отсутствие расклада в payload = «форма его не
    // прислала», удаление — отдельное намерение.
    //
    // Закрытые не удаляем никогда: по ним уже выпущены паспорта
    // (`Passport.cuttingLayOrdinal`). Расклад, пришедший и в `lays`, и в
    // `removedOrdinals`, считаем правкой — данные важнее.
    const keptOrdinals = new Set(updates.map((u) => u.ordinal));
    const removedOrdinals = new Set(dto.removedOrdinals ?? []);
    const layIdsToDelete = task.lays
      .filter(
        (l) =>
          !l.completedAt &&
          !keptOrdinals.has(l.ordinal) &&
          removedOrdinals.has(l.ordinal),
      )
      .map((l) => l.id);
    let nextOrdinal =
      task.lays.reduce((max, l) => Math.max(max, l.ordinal), 0) + 1;

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
    // Рулон ERP — только из зеркала остатка по материалам этого заказа: чужой рулон
    // отправил бы ERP списывать не ту ткань.
    const erpRollLabels = new Map<string, string>();
    if (dto.lays.some((l) => l.rolls.some((r) => r.erpSeriesId))) {
      const orderIdRow = await this.prisma.cuttingTask.findUnique({ where: { id }, select: { orderId: true } });
      for (const er of await this.listErpRolls(orderIdRow?.orderId ?? '')) erpRollLabels.set(er.seriesId, er.label);
      // Уже выбранные рулоны задачи разрешены всегда: докроенный до нуля рулон уходит из
      // зеркала остатка, и без этого расклад с ним стало бы невозможно сохранить или закрыть.
      const known = await this.prisma.cuttingTaskRoll.findMany({
        where: { lay: { taskId: id }, erpSeriesId: { not: null } },
        select: { erpSeriesId: true, erpRollLabel: true },
      });
      for (const k of known) {
        if (k.erpSeriesId && !erpRollLabels.has(k.erpSeriesId)) {
          erpRollLabels.set(k.erpSeriesId, k.erpRollLabel ?? k.erpSeriesId);
        }
      }
      for (const lay of dto.lays) {
        for (const r of lay.rolls) {
          if (r.erpSeriesId && !erpRollLabels.has(r.erpSeriesId)) {
            throw new CuttingTaskPayloadInvalidException(
              `Рулон ERP ${r.erpSeriesId} не относится к материалам этого заказа`,
            );
          }
        }
      }
    }

    // Гейт завершения: «Раскрой завершён» — только с полностью заполненным
    // настилом (иначе задача уйдёт на доску помощника с нулями и выпускать
    // паспорта будет не из чего). Автосейв (`markDone: false`) нули
    // пропускает — это нормальное промежуточное состояние формы.
    //
    // Частичное завершение: проверяем ТОЛЬКО то, что придёт в payload —
    // уже закрытые расклады свою проверку прошли при закрытии, а форма
    // может их вообще не присылать.
    if (opts.markDone) {
      // Пустой payload при уже закрытых раскладах — валидный кейс «остались
      // только закрытые, добивать нечего» (`hasClosedLays`).
      const problems = listCuttingCompletionProblems(
        dto.lays,
        (sizeId) => sizeMeta.get(sizeId)?.sizeCodeSnapshot ?? sizeId,
        { hasClosedLays: task.lays.some((l) => l.completedAt) },
      );
      if (problems.length > 0) {
        throw new CuttingTaskCompletionIncompleteException(problems);
      }
    }

    const layData = (lay: CuttingTaskLayInputDto) => ({
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
            erpSeriesId: r.erpSeriesId ?? null,
            erpRollLabel: r.erpSeriesId ? (erpRollLabels.get(r.erpSeriesId) ?? null) : null,
          })),
        },
      },
    });

    await this.prisma.$transaction(async (tx) => {
      // 1. Удалить открытые расклады, которых больше нет в payload
      //    (каскад снесёт их laySizes и rolls). Закрытые не трогаем.
      if (layIdsToDelete.length > 0) {
        await tx.cuttingTaskLay.deleteMany({
          where: { id: { in: layIdsToDelete } },
        });
      }

      // 2. Обновить существующие открытые расклады: содержимое (размеры +
      //    рулоны) переписываем целиком, сам расклад и его `ordinal`
      //    сохраняем — иначе `Passport.cuttingLayOrdinal` поедет.
      for (const u of updates) {
        await tx.cuttingTaskLaySize.deleteMany({ where: { layId: u.layId } });
        await tx.cuttingTaskRoll.deleteMany({ where: { layId: u.layId } });
        await tx.cuttingTaskLay.update({
          where: { id: u.layId },
          data: layData(u.lay),
        });
      }

      // 3. Создать новые расклады — номера append-only от максимума.
      for (const lay of creates) {
        await tx.cuttingTaskLay.create({
          data: {
            taskId: id,
            ordinal: nextOrdinal,
            ...layData(lay),
          },
        });
        nextOrdinal += 1;
      }

      if (opts.markDone) {
        // «Раскрой завершён» = закрыть всё, что ещё открыто, и перевести
        // задачу в DONE. Закрытые расклады сохраняют свой `completedAt`
        // (кто и когда закрыл — не переписываем).
        const now = new Date();
        await tx.cuttingTaskLay.updateMany({
          where: { taskId: id, completedAt: null },
          data: { completedAt: now, completedById: opts.employeeId ?? null },
        });
        await tx.cuttingTask.update({
          where: { id },
          data: { status: 'DONE', completedAt: now },
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ЧАСТИЧНОЕ ЗАВЕРШЕНИЕ РАСКРОЯ ПО РАСКЛАДУ
  // ---------------------------------------------------------------------------

  /**
   * «Расклад готов» — закрыть ОДИН расклад, не завершая раскрой заказа.
   *
   * Что даёт: по закрытому раскладу сразу можно выпускать паспорта
   * (`PassportsService.releaseFromRolls`), пока остальные расклады
   * настилаются; заказ появляется в очереди выпуска
   * (`listReadyForRelease`) с `cuttingInProgress = true`.
   *
   * Гейты:
   *   - задача в работе (`IN_PROGRESS`) — иначе нечего закрывать;
   *   - расклад существует и ещё не закрыт (повтор — идемпотентно, просто
   *     возвращаем карточку);
   *   - настил заполнен целиком (`listLayCompletionProblems`), иначе
   *     `CUTTING_LAY_COMPLETION_INCOMPLETE` — те же формулировки, что у
   *     «Раскрой завершён».
   *
   * Прогресс формы НЕ сохраняем здесь: клиент сначала делает
   * `PATCH /cutting-tasks/:id` (или автосейв), потом закрывает расклад —
   * так закрытие проверяет ровно то, что уже лежит в БД.
   */
  async completeLay(
    id: string,
    ordinal: number,
    employeeId: string | null,
  ): Promise<CuttingTaskDetailDto> {
    const task = await this.prisma.cuttingTask.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        lays: {
          where: { ordinal },
          select: {
            id: true,
            completedAt: true,
            laySizes: { select: { sizeId: true, sizeCodeSnapshot: true, perLayerQty: true } },
            rolls: { select: { ordinal: true, layers: true } },
          },
        },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();
    if (task.status !== 'IN_PROGRESS') {
      throw new CuttingTaskNotInProgressException();
    }
    const lay = task.lays[0];
    if (!lay) throw new CuttingLayNotFoundException(ordinal);
    // Идемпотентность: закрытый расклад повторно не закрываем и не ругаемся
    // (двойной тап по кнопке на планшете — обычное дело).
    if (lay.completedAt) return this.getOne(id);

    const labels = new Map(
      lay.laySizes
        .filter((s) => s.sizeId)
        .map((s) => [s.sizeId as string, s.sizeCodeSnapshot]),
    );
    const problems = listLayCompletionProblems(
      {
        laySizes: lay.laySizes
          .filter((s) => s.sizeId)
          .map((s) => ({ sizeId: s.sizeId as string, perLayerQty: s.perLayerQty })),
        rolls: lay.rolls.map((r) => ({ ordinal: r.ordinal, layers: r.layers })),
      },
      (sizeId) => labels.get(sizeId) ?? sizeId,
    );
    if (problems.length > 0) {
      throw new CuttingLayCompletionIncompleteException(ordinal, problems);
    }

    await this.prisma.cuttingTaskLay.update({
      where: { id: lay.id },
      data: { completedAt: new Date(), completedById: employeeId ?? null },
    });
    this.logger.log(
      `event=cutting-lay.completed taskId=${id} ordinal=${ordinal} employeeId=${employeeId ?? '—'}`,
    );
    return this.getOne(id);
  }

  /**
   * «Открыть расклад» — снять закрытие, чтобы поправить настил
   * (раскройщик ошибся в «на настиле»/слоях или закрыл лишний расклад).
   *
   * Что делаем с уже выпущенными по раскладу паспортами. Настил и
   * паспорт связаны жёстко: паспорт несёт снимок расклада (`qtyCut` =
   * слои × «на настиле», номер «Расклад N · Рулон M»). Открыть расклад и
   * оставить старые паспорта — значит развести бумагу в цехе с данными в
   * системе. Поэтому:
   *   - «свежие» паспорта (`CREATED`, без ячейки, без событий кроме
   *     `CREATED`, не в коробке, без проведённого списания материалов)
   *     удаляются вместе с открытием расклада — в одной транзакции, с
   *     `AuditLog` на каждый. Раскройщик подтверждает это в форме, видя
   *     их число (`CuttingTaskLayDto.reopenDeletesPassports`). Каскадом
   *     уходят и сдельные начисления за выпуск (`OperationEntry`) — как
   *     при самостоятельном удалении паспорта автором: выпуска не
   *     случилось, начислять не за что;
   *   - паспорт, который УЖЕ ушёл в работу, не удаляем и расклад не
   *     открываем — `CUTTING_LAY_HAS_PASSPORTS` с номерами. Такие
   *     паспорта отменяет мастер.
   *
   * Права автора паспорта здесь НЕ проверяем (в отличие от
   * `PassportsService.delete`): расклад — единица работы раскройщика, а
   * выпустить по нему паспорта мог помощник. Иначе типовой цех, где
   * печатает помощник, не смог бы исправить ошибку настила вообще.
   *
   * Работает и для задачи в статусе `DONE`: тогда задача возвращается в
   * `IN_PROGRESS` (раскрой снова идёт) — иначе расклад открыт, а форма
   * read-only.
   */
  async reopenLay(
    id: string,
    ordinal: number,
    employeeId: string | null = null,
  ): Promise<CuttingTaskDetailDto> {
    const task = await this.prisma.cuttingTask.findUnique({
      where: { id },
      select: {
        id: true,
        orderId: true,
        status: true,
        lays: { where: { ordinal }, select: { id: true, completedAt: true } },
      },
    });
    if (!task) throw new CuttingTaskNotFoundException();
    const lay = task.lays[0];
    if (!lay) throw new CuttingLayNotFoundException(ordinal);
    // Уже открыт — идемпотентно.
    if (!lay.completedAt) return this.getOne(id);

    const passports = await this.loadLayPassports(task.orderId, ordinal);
    const blocked = passports.filter((p) => p.moved);
    if (blocked.length > 0) {
      throw new CuttingLayHasPassportsException(
        ordinal,
        blocked
          .slice(0, CUTTING_LAY_BLOCKING_PASSPORTS_SHOWN)
          .map((p) => p.number),
        blocked.length,
      );
    }
    const staleIds = passports.map((p) => p.id);

    await this.prisma.$transaction(async (tx) => {
      if (staleIds.length > 0) {
        await tx.passportDefect.deleteMany({
          where: { passportId: { in: staleIds } },
        });
        await tx.operationEntry.deleteMany({
          where: { passportId: { in: staleIds } },
        });
        await tx.passportEvent.deleteMany({
          where: { passportId: { in: staleIds } },
        });
        // Условие «свежести» повторяем в самом DELETE: между проверкой и
        // транзакцией паспорт могли разместить в ячейке или отсканировать
        // (помощник работает параллельно). Если снеслось меньше, чем
        // собирались, — кто-то успел, откатываем всё и просим повторить.
        const deleted = await tx.passport.deleteMany({
          where: { id: { in: staleIds }, status: 'CREATED', currentCellId: null },
        });
        if (deleted.count !== staleIds.length) {
          // Уцелевшие (значит, уже двинувшиеся) паспорта ещё в БД —
          // называем их в ошибке; транзакция откатится целиком.
          const survivors = await tx.passport.findMany({
            where: { id: { in: staleIds } },
            orderBy: { number: 'asc' },
            take: CUTTING_LAY_BLOCKING_PASSPORTS_SHOWN,
            select: { number: true },
          });
          throw new CuttingLayHasPassportsException(
            ordinal,
            survivors.map((s) => s.number),
            staleIds.length - deleted.count,
          );
        }
        for (const p of passports) {
          await this.audit.log(
            {
              event: 'PASSPORT_DELETED',
              entityType: 'PASSPORT',
              entityId: p.id,
              employeeId,
              // Набор полей — как у `PassportsService.delete`, чтобы
              // разбор инцидента не зависел от того, каким путём паспорт
              // снесли; `reason` отличает удаление ради правки настила.
              payload: {
                number: p.number,
                orderId: task.orderId,
                sizeId: p.sizeId,
                qtyCut: p.qtyCut,
                cuttingLayOrdinal: ordinal,
                rollOrdinal: p.rollOrdinal,
                reason: 'CUTTING_LAY_REOPENED',
              },
            },
            tx,
          );
        }
      }
      await tx.cuttingTaskLay.update({
        where: { id: lay.id },
        data: { completedAt: null, completedById: null },
      });
      if (task.status === 'DONE') {
        await tx.cuttingTask.update({
          where: { id },
          data: { status: 'IN_PROGRESS', completedAt: null },
        });
      }
    });
    this.logger.log(
      `event=cutting-lay.reopened taskId=${id} ordinal=${ordinal} taskWasDone=${task.status === 'DONE'} passportsDeleted=${staleIds.length}`,
    );
    return this.getOne(id);
  }

  /**
   * Паспорта, выпущенные по раскладам заказа, с признаком «уже ушёл в
   * работу» (`moved`). Без `ordinal` — по всем раскладам (карточка
   * задачи), с `ordinal` — по одному (гейт «Открыть расклад»).
   *
   * Отменённые (`CANCELLED`) паспорта не в счёт: они не занимают тройку
   * «расклад × размер × рулон» и открытию расклада не мешают.
   */
  private async loadLayPassports(
    orderId: string,
    ordinal?: number,
  ): Promise<LayPassportState[]> {
    const passports = await this.prisma.passport.findMany({
      where: {
        orderId,
        status: { not: 'CANCELLED' },
        cuttingLayOrdinal: ordinal == null ? { not: null } : ordinal,
      },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        number: true,
        status: true,
        sizeId: true,
        rollOrdinal: true,
        cuttingLayOrdinal: true,
        currentCellId: true,
        qtyCut: true,
        // Упакованный паспорт и проведённое списание материалов — тоже
        // «ушёл в работу»: их сносить нельзя (см. `PassportsService.delete`).
        boxItems: { select: { id: true }, take: 1 },
        materialIssues: {
          where: { status: 'POSTED' },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (passports.length === 0) return [];

    // Любое событие кроме `CREATED` = паспорт двигался (выдан, сканирован,
    // размещён). Одним запросом на все паспорта — без N+1.
    const events = await this.prisma.passportEvent.findMany({
      where: {
        passportId: { in: passports.map((p) => p.id) },
        type: { not: 'CREATED' },
      },
      select: { passportId: true },
      distinct: ['passportId'],
    });
    const withEvents = new Set(events.map((e) => e.passportId));

    return passports.map((p) => ({
      id: p.id,
      number: p.number,
      layOrdinal: p.cuttingLayOrdinal as number,
      sizeId: p.sizeId,
      rollOrdinal: p.rollOrdinal,
      qtyCut: p.qtyCut,
      moved:
        p.status !== 'CREATED' ||
        p.currentCellId != null ||
        withEvents.has(p.id) ||
        p.boxItems.length > 0 ||
        p.materialIssues.length > 0,
    }));
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
