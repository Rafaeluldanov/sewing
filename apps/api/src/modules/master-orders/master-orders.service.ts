import { Injectable } from '@nestjs/common';
import {
  MASTER_ORDER_TAB_STATUSES,
  isOrderRouteEditable,
  isOrderStarted,
  type MasterOrderListItemDto,
  type MasterOrderRouteStepDto,
  type MasterOrderTab,
  type MasterOrdersDto,
  type MasterOrdersQuery,
} from '@sewing/shared';
import { PassportStatus, type OrderStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Вкладка «Заказы» кабинета мастера: список заказов с маршрутом и
 * фронтом производства (см. `packages/shared/src/master-orders.ts`).
 *
 * Read-only. Правка маршрута идёт существующей ручкой
 * `PUT /orders/:id/amendments/route` — здесь только чтение, чтобы
 * инварианты правки (замороженный префикс, журнал, пересчёт плана)
 * остались в одном месте (`OrderAmendmentsService`).
 */
@Injectable()
export class MasterOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MasterOrdersQuery): Promise<MasterOrdersDto> {
    const statuses = [...MASTER_ORDER_TAB_STATUSES[query.tab]] as OrderStatus[];
    const where: Prisma.OrderWhereInput = {
      status: { in: statuses },
      ...searchWhere(query.search),
    };

    const orders = await this.prisma.order.findMany({
      where,
      // Срок — главная ось смены. Заказы без срока уходят вниз (`nulls:
      // 'last'`), внутри одного дня порядок стабилен по номеру.
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
      // Потолок на список: у мастера телефон, и «все 900 заказов» —
      // это не экран, а таймаут. Заказы в работе в этот лимит
      // помещаются с запасом, для остального есть поиск.
      take: LIST_LIMIT,
      select: {
        id: true,
        number: true,
        status: true,
        color: true,
        dueDate: true,
        inProductionAt: true,
        client: { select: { name: true } },
        customer: true,
        items: {
          // У `OrderItem` нет `createdAt`; порядок нужен только чтобы
          // «первая позиция» была одной и той же между запросами.
          orderBy: { id: 'asc' },
          select: { qtyPlan: true, product: { select: { name: true } } },
        },
        routeSteps: {
          orderBy: { index: 'asc' },
          select: {
            index: true,
            parallelGroup: true,
            operation: {
              select: { code: true, name: true, category: true },
            },
          },
        },
        // Тонкий select по паспортам: фронт производства, счётчик и
        // Σ упакованного считаются одним проходом по этому же массиву —
        // отдельные aggregate-запросы на каждый заказ дали бы N+1.
        passports: {
          where: { status: { not: PassportStatus.CANCELLED } },
          select: { qtyGood: true, status: true, currentRouteStepIndex: true },
        },
      },
    });

    const counts = await this.tabCounts();
    return { items: orders.map(toDto), counts };
  }

  /**
   * Счётчики вкладок. Считаются по статусу и БЕЗ поиска: цифра рядом с
   * вкладкой отвечает на «сколько там всего», а не «сколько нашлось» —
   * иначе она прыгала бы на каждой букве в поле поиска.
   */
  private async tabCounts(): Promise<Record<MasterOrderTab, number>> {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const byStatus = new Map<string, number>(
      rows.map((r) => [r.status, r._count._all]),
    );
    const sum = (tab: MasterOrderTab): number =>
      MASTER_ORDER_TAB_STATUSES[tab].reduce(
        (acc, s) => acc + (byStatus.get(s) ?? 0),
        0,
      );
    return {
      production: sum('production'),
      pending: sum('pending'),
      done: sum('done'),
    };
  }
}

/** Потолок строк списка (см. комментарий у `take`). */
const LIST_LIMIT = 200;

/**
 * Поиск по номеру заказа, изделию и клиенту. Пустая строка — не фильтр:
 * `undefined` вместо пустого `OR`, иначе Prisma получит всегда-ложное
 * условие и список молча опустеет.
 */
function searchWhere(search?: string): Prisma.OrderWhereInput {
  const q = search?.trim();
  if (!q) return {};
  return {
    OR: [
      { number: { contains: q, mode: 'insensitive' } },
      { customer: { contains: q, mode: 'insensitive' } },
      { client: { name: { contains: q, mode: 'insensitive' } } },
      { items: { some: { product: { name: { contains: q, mode: 'insensitive' } } } } },
    ],
  };
}

interface OrderRow {
  id: string;
  number: string;
  status: OrderStatus;
  color: string | null;
  dueDate: Date | null;
  inProductionAt: Date | null;
  client: { name: string } | null;
  customer: string | null;
  items: { qtyPlan: number; product: { name: string } | null }[];
  routeSteps: {
    index: number;
    parallelGroup: number | null;
    operation: { code: string; name: string; category: string | null } | null;
  }[];
  passports: {
    qtyGood: number;
    status: PassportStatus;
    currentRouteStepIndex: number | null;
  }[];
}

function toDto(o: OrderRow): MasterOrderListItemDto {
  // Фронт производства — та же формула, что в `OrderAmendmentsService`:
  // максимальный шаг живых паспортов, −1 если паспортов нет. Считаем по
  // уже загруженному массиву, повторный aggregate не нужен.
  let frontierIndex = -1;
  let qtyFinishedTotal = 0;
  for (const p of o.passports) {
    if (p.currentRouteStepIndex != null && p.currentRouteStepIndex > frontierIndex) {
      frontierIndex = p.currentRouteStepIndex;
    }
    if (p.status === PassportStatus.PACKED) qtyFinishedTotal += p.qtyGood;
  }

  const steps: MasterOrderRouteStepDto[] = o.routeSteps.map((s) => ({
    index: s.index,
    operationCode: s.operation?.code ?? '',
    operationName: s.operation?.name ?? s.operation?.code ?? '—',
    operationCategory: s.operation?.category ?? null,
    parallelGroup: s.parallelGroup ?? null,
    passed: s.index <= frontierIndex,
  }));

  return {
    id: o.id,
    number: o.number,
    status: o.status,
    productName: o.items[0]?.product?.name ?? null,
    color: o.color,
    clientName: o.client?.name ?? o.customer ?? null,
    dueDate: o.dueDate?.toISOString() ?? null,
    inProductionAt: o.inProductionAt?.toISOString() ?? null,
    qtyPlanTotal: o.items.reduce((s, i) => s + i.qtyPlan, 0),
    qtyFinishedTotal,
    passportCount: o.passports.length,
    frontierIndex,
    routeEditable: isOrderRouteEditable(o.status),
    started: isOrderStarted(o.status),
    steps,
  };
}
