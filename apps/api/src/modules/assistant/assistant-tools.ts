/**
 * Инструменты ассистента — ТОЛЬКО ЧТЕНИЕ.
 *
 * Каждый инструмент — тонкая обёртка над данными тенанта, которая:
 *   - исполняется в контексте текущего HTTP-запроса, а значит под тем же
 *     тенантом (`PrismaService` — Proxy по `TenantContext`) и с теми же
 *     правами, что и обычный вызов API;
 *   - отдаёт КОМПАКТНЫЙ результат, а не сырую строку Prisma: модель
 *     платит токенами за каждое поле, а лишние поля ещё и провоцируют
 *     её досочинять;
 *   - возвращает `sources` — ссылки на экраны админки, по которым
 *     пользователь проверит число глазами.
 *
 * Границы, которые здесь соблюдаются жёстко:
 *   - НИКАКИХ мутаций. Ни одного `create`/`update`/`delete`;
 *   - никакого самостоятельного пересчёта денег. Инструмент `order_estimate`
 *     отдаёт УЖЕ ПОСЧИТАННУЮ системой смету — иначе числа разойдутся со
 *     сметой, «Операциями», «Сводно» и плановой себестоимостью;
 *   - каждый инструмент привязан к группе данных (`AssistantDataScope`).
 *     Выключенная в настройках группа не попадает в запрос к модели
 *     вообще — модель не может «уговорить» позвать то, чего ей не дали.
 *
 * См. `packages/shared/src/assistant.ts`, `assistant.service.ts`.
 */

import type {
  AssistantDataScope,
  AssistantSourceDto,
} from '@sewing/shared/assistant';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { searchKnowledge } from './knowledge.js';

// ---------------------------------------------------------------------------
// Контракт инструмента
// ---------------------------------------------------------------------------

export interface AssistantToolContext {
  prisma: PrismaService;
  /** Кто спрашивает — для инструментов, которым нужен «мой» срез. */
  employeeId: string;
}

export interface AssistantToolResult {
  /** Компактные данные для модели (уедут в JSON). */
  data: unknown;
  /** Ссылки для проверки ответа глазами. */
  sources?: AssistantSourceDto[];
}

export interface AssistantTool {
  /**
   * Машинное имя для API. ТОЛЬКО `[a-zA-Z0-9_-]`, до 128 символов —
   * это требование Anthropic (`tools.N.custom.name`). Точка в имени
   * (`orders.search`) валит ВЕСЬ запрос в 400, причём не при старте, а
   * на первом же вопросе пользователя. Разделитель — подчёркивание.
   */
  name: string;
  /** Человеческая подпись для строки «Смотрю заказы». */
  label: string;
  /**
   * Группа данных. `null` — инструмент вне групп (справка): он не
   * трогает данные тенанта и доступен всегда.
   */
  scope: AssistantDataScope | null;
  /**
   * Описание для модели. Пишется ПРЕДПИСАТЕЛЬНО — «зови, когда…», а не
   * «этот инструмент умеет…»: от формулировки напрямую зависит, догадается
   * ли модель его позвать.
   */
  description: string;
  /** JSON Schema параметров (уезжает в API как `input_schema`). */
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult>;
}

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

/** Потолок строк в одном ответе: длинные списки не помогают, а стоят денег. */
const ROW_LIMIT = 25;

const ORDER_STATUS_RU: Record<string, string> = {
  DRAFT: 'Черновик',
  CALCULATION: 'Расчёт',
  CALCULATION_DONE: 'Расчёт готов',
  SAMPLE_PRODUCTION: 'Образец',
  IN_PRODUCTION: 'В производстве',
  DONE: 'Готов',
  CANCELLED: 'Отменён',
};

const PASSPORT_STATUS_RU: Record<string, string> = {
  CREATED: 'Выпущен',
  IN_PROGRESS: 'В работе',
  PACKED: 'Упакован',
  CANCELLED: 'Аннулирован',
};

function isoDay(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function bool(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

// ---------------------------------------------------------------------------
// PRODUCTION
// ---------------------------------------------------------------------------

const ordersSearch: AssistantTool = {
  name: 'orders_search',
  label: 'Смотрю заказы',
  scope: 'PRODUCTION',
  description:
    'Найти заказы и посчитать их количество. Зови, когда спрашивают ' +
    '«сколько заказов в работе», «какие заказы у клиента X», «что горит ' +
    'по сроку», «покажи заказы в производстве». Возвращает список с ' +
    'номером, клиентом, статусом, сроком и готовностью по паспортам.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [
          'DRAFT',
          'CALCULATION',
          'CALCULATION_DONE',
          'SAMPLE_PRODUCTION',
          'IN_PRODUCTION',
          'DONE',
          'CANCELLED',
        ],
        description: 'Фильтр по статусу заказа',
      },
      client: { type: 'string', description: 'Часть названия клиента' },
      overdueOnly: {
        type: 'boolean',
        description: 'Только заказы, у которых срок уже прошёл, а статус не DONE/CANCELLED',
      },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const status = str(input, 'status');
    const client = str(input, 'client');
    const overdueOnly = bool(input, 'overdueOnly');

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (client) {
      where.OR = [
        { client: { name: { contains: client, mode: 'insensitive' } } },
        { customer: { contains: client, mode: 'insensitive' } },
      ];
    }
    if (overdueOnly) {
      where.dueDate = { lt: new Date() };
      where.status = { notIn: ['DONE', 'CANCELLED'] };
    }

    const [total, rows] = await Promise.all([
      ctx.prisma.order.count({ where }),
      ctx.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          id: true,
          number: true,
          status: true,
          dueDate: true,
          customer: true,
          client: { select: { name: true } },
          patternNameSnapshot: true,
          _count: { select: { passports: true } },
        },
      }),
    ]);

    // Готовность считаем одним групповым запросом, а не N+1 по заказам.
    const packed = rows.length
      ? await ctx.prisma.passport.groupBy({
          by: ['orderId'],
          where: { orderId: { in: rows.map((r) => r.id) }, status: 'PACKED' },
          _count: { _all: true },
        })
      : [];
    const packedByOrder = new Map(packed.map((p) => [p.orderId, p._count._all]));

    return {
      data: {
        total,
        shown: rows.length,
        orders: rows.map((r) => ({
          number: r.number,
          client: r.client?.name ?? r.customer ?? null,
          product: r.patternNameSnapshot,
          status: ORDER_STATUS_RU[r.status] ?? r.status,
          dueDate: isoDay(r.dueDate),
          passportsTotal: r._count.passports,
          passportsPacked: packedByOrder.get(r.id) ?? 0,
        })),
      },
      sources: rows.slice(0, 5).map((r) => ({
        label: `Заказ ${r.number}`,
        sublabel: r.client?.name ?? r.customer ?? null,
        href: `/admin/orders/${r.id}`,
      })),
    };
  },
};

const orderGet: AssistantTool = {
  name: 'order_get',
  label: 'Открываю заказ',
  scope: 'PRODUCTION',
  description:
    'Подробности одного заказа по его номеру (например «02-00013»): ' +
    'статус, клиент, срок, расцветки с количествами, готовность по ' +
    'паспортам. Зови, когда спрашивают про конкретный заказ.',
  inputSchema: {
    type: 'object',
    properties: {
      number: { type: 'string', description: 'Номер заказа, например 02-00013' },
    },
    required: ['number'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const number = str(input, 'number');
    if (!number) return { data: { error: 'Не указан номер заказа' } };

    const order = await ctx.prisma.order.findUnique({
      where: { number },
      select: {
        id: true,
        number: true,
        status: true,
        orderDate: true,
        dueDate: true,
        customer: true,
        comment: true,
        client: { select: { name: true } },
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
        companyDivision: { select: { name: true } },
        variants: {
          orderBy: { ordinal: 'asc' },
          select: {
            color: true,
            sizes: { select: { qtyPlan: true } },
          },
        },
      },
    });
    if (!order) {
      return { data: { found: false, number } };
    }

    const byStatus = await ctx.prisma.passport.groupBy({
      by: ['status'],
      where: { orderId: order.id },
      _count: { _all: true },
    });

    return {
      data: {
        found: true,
        number: order.number,
        client: order.client?.name ?? order.customer ?? null,
        product: order.patternNameSnapshot,
        article: order.patternArticleSnapshot,
        division: order.companyDivision?.name ?? null,
        status: ORDER_STATUS_RU[order.status] ?? order.status,
        orderDate: isoDay(order.orderDate),
        dueDate: isoDay(order.dueDate),
        comment: order.comment,
        colorways: order.variants.map((v) => ({
          color: v.color,
          qty: v.sizes.reduce((sum, s) => sum + s.qtyPlan, 0),
        })),
        passports: Object.fromEntries(
          byStatus.map((g) => [
            PASSPORT_STATUS_RU[g.status] ?? g.status,
            g._count._all,
          ]),
        ),
      },
      sources: [
        {
          label: `Заказ ${order.number}`,
          sublabel: order.client?.name ?? order.customer ?? null,
          href: `/admin/orders/${order.id}`,
        },
      ],
    };
  },
};

const passportLocate: AssistantTool = {
  name: 'passport_locate',
  label: 'Ищу паспорт',
  scope: 'PRODUCTION',
  description:
    'Где сейчас паспорт: статус, операция, у кого на руках, ячейка, к ' +
    'какому заказу относится. Зови на вопросы вида «где паспорт ' +
    'P-20260813-0007», «что с паспортом …». Различай два поля: ' +
    '`operationInProgress` — операция выполняется прямо сейчас (паспорт у ' +
    'исполнителя), `lastCompletedOperation` — последняя ПРОЙДЕННАЯ ' +
    'операция (паспорт лежит и ждёт следующей). Не выдавай вторую за первую.',
  inputSchema: {
    type: 'object',
    properties: {
      number: {
        type: 'string',
        description: 'Номер паспорта, например P-20260813-0007',
      },
    },
    required: ['number'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const number = str(input, 'number');
    if (!number) return { data: { error: 'Не указан номер паспорта' } };

    const p = await ctx.prisma.passport.findUnique({
      where: { number },
      select: {
        id: true,
        number: true,
        status: true,
        color: true,
        qtyPlan: true,
        qtyGood: true,
        qtyDefect: true,
        cutDate: true,
        order: { select: { id: true, number: true } },
        size: { select: { code: true } },
        currentOperation: { select: { name: true } },
        currentEmployee: { select: { fullName: true } },
        currentCell: { select: { code: true } },
      },
    });
    if (!p) return { data: { found: false, number } };

    // ВАЖНО про семантику `currentOperationId`. После завершения операции
    // сервис пишет туда ЗАВЕРШЁННУЮ операцию и обнуляет `currentEmployeeId`
    // (см. `passports.service.ts` — `afterSnapshot`). То есть одно и то же
    // поле значит разное: пока паспорт у исполнителя — это операция В
    // РАБОТЕ, после сдачи — ПОСЛЕДНЯЯ ПРОЙДЕННАЯ. Отдавать это модели под
    // одним именем «текущая операция» нельзя: она ответит «шьётся на
    // распошивалке» про паспорт, который там уже отработал и лежит в ячейке.
    const inProgress = Boolean(p.currentEmployee);

    return {
      data: {
        found: true,
        number: p.number,
        status: PASSPORT_STATUS_RU[p.status] ?? p.status,
        order: p.order.number,
        size: p.size.code,
        color: p.color,
        qtyPlan: p.qtyPlan,
        qtyGood: p.qtyGood,
        qtyDefect: p.qtyDefect,
        cutDate: isoDay(p.cutDate),
        operationInProgress: inProgress ? (p.currentOperation?.name ?? null) : null,
        lastCompletedOperation: inProgress ? null : (p.currentOperation?.name ?? null),
        holder: p.currentEmployee?.fullName ?? null,
        currentCell: p.currentCell?.code ?? null,
      },
      sources: [
        {
          label: `Паспорт ${p.number}`,
          sublabel: `Заказ ${p.order.number}`,
          href: `/passports/${p.id}`,
        },
      ],
    };
  },
};

const productionQueue: AssistantTool = {
  name: 'production_queue',
  label: 'Считаю очередь по операциям',
  scope: 'PRODUCTION',
  description:
    'Сколько паспортов стоит на каждой операции прямо сейчас — где ' +
    'узкое место цеха. Зови на вопросы «что тормозит», «где затык», ' +
    '«сколько висит на распошивалке», «загрузка цеха».',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, ctx) {
    const groups = await ctx.prisma.passport.groupBy({
      by: ['currentOperationId'],
      where: { status: 'IN_PROGRESS', currentOperationId: { not: null } },
      _count: { _all: true },
    });
    const ids = groups
      .map((g) => g.currentOperationId)
      .filter((id): id is string => Boolean(id));
    const ops = ids.length
      ? await ctx.prisma.operation.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, code: true },
        })
      : [];
    const nameById = new Map(ops.map((o) => [o.id, o.name]));

    const queue = groups
      .map((g) => ({
        operation: nameById.get(g.currentOperationId ?? '') ?? 'Неизвестно',
        passports: g._count._all,
      }))
      .sort((a, b) => b.passports - a.passports)
      .slice(0, ROW_LIMIT);

    return {
      data: { queue, totalInProgress: queue.reduce((s, q) => s + q.passports, 0) },
      sources: [
        {
          label: 'Цеховой монитор',
          sublabel: 'Очередь по операциям',
          href: '/admin/display-screens',
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// SUPPLY
// ---------------------------------------------------------------------------

const workshopNeeds: AssistantTool = {
  name: 'workshop_needs',
  label: 'Смотрю потребность цеха',
  scope: 'SUPPLY',
  description:
    'Потребность в материалах по заказу: что и сколько нужно закупить. ' +
    'Зови на вопросы «что нужно купить по заказу X», «какая потребность ' +
    'по материалам», «сколько ткани надо».',
  inputSchema: {
    type: 'object',
    properties: {
      orderNumber: { type: 'string', description: 'Номер заказа' },
    },
    required: ['orderNumber'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const orderNumber = str(input, 'orderNumber');
    if (!orderNumber) return { data: { error: 'Не указан номер заказа' } };

    const order = await ctx.prisma.order.findUnique({
      where: { number: orderNumber },
      select: { id: true, number: true },
    });
    if (!order) return { data: { found: false, orderNumber } };

    // Потребность принадлежит ВАРИАНТУ ПРОСЧЁТА: у заказа их может быть
    // несколько, и выборка по одному `orderId` сложила бы строки всех
    // вариантов — материалы задвоились бы. Берём активный вариант, а если
    // его нет (заказы до фичи вариантов) — строки без привязки.
    const activeCalculation = await ctx.prisma.orderCalculation.findFirst({
      where: { orderId: order.id, isActive: true },
      select: { id: true },
    });

    const needs = await ctx.prisma.workshopNeed.findMany({
      where: {
        orderId: order.id,
        orderCalculationId: activeCalculation ? activeCalculation.id : null,
      },
      take: ROW_LIMIT,
      select: {
        description: true,
        sourceName: true,
        resolvedColorText: true,
        calculatedQty: true,
        purchaseQty: true,
        unit: true,
        isManual: true,
      },
    });

    return {
      data: {
        found: true,
        order: order.number,
        lines: needs.map((n) => ({
          material: n.sourceName ?? n.description,
          color: n.resolvedColorText,
          qty: Number(n.purchaseQty ?? n.calculatedQty),
          unit: n.unit,
          manuallyEdited: n.isManual,
        })),
      },
      sources: [
        {
          label: 'Потребность цеха',
          sublabel: `Заказ ${order.number}`,
          href: '/admin/workshop-needs',
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// MONEY — только УЖЕ ПОСЧИТАННОЕ системой
// ---------------------------------------------------------------------------

const orderEstimate: AssistantTool = {
  name: 'order_estimate',
  label: 'Читаю смету заказа',
  scope: 'MONEY',
  description:
    'Готовая смета заказа: плановая себестоимость, посчитанная системой. ' +
    'Зови на вопросы «во сколько обойдётся заказ», «какая себестоимость». ' +
    'ВАЖНО: это уже посчитанное значение. Не пересчитывай его сам и не ' +
    'строй сценарии «а что если» — отправь пользователя в смету заказа.',
  inputSchema: {
    type: 'object',
    properties: {
      orderNumber: { type: 'string', description: 'Номер заказа' },
    },
    required: ['orderNumber'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const orderNumber = str(input, 'orderNumber');
    if (!orderNumber) return { data: { error: 'Не указан номер заказа' } };

    const order = await ctx.prisma.order.findUnique({
      where: { number: orderNumber },
      select: { id: true, number: true },
    });
    if (!order) return { data: { found: false, orderNumber } };

    const estimate = await ctx.prisma.orderCostEstimate.findFirst({
      where: { orderId: order.id, status: 'COMPLETED', revokedAt: null },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        totalCostRub: true,
        completedAt: true,
        comment: true,
      },
    });

    return {
      data: estimate
        ? {
            found: true,
            order: order.number,
            version: estimate.version,
            totalCostRub: Number(estimate.totalCostRub),
            completedAt: estimate.completedAt.toISOString(),
            comment: estimate.comment,
          }
        : { found: false, order: order.number, reason: 'Смета ещё не завершена' },
      sources: [
        {
          label: `Смета заказа ${order.number}`,
          sublabel: 'Проверить и пересчитать можно здесь',
          href: `/admin/orders/${order.id}`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Справка (вне групп)
// ---------------------------------------------------------------------------

const docsLookup: AssistantTool = {
  name: 'docs_lookup',
  label: 'Читаю справку',
  scope: null,
  description:
    'Справка об устройстве системы: статусы заказа, паспорта и маршруты, ' +
    'роли и доступы, потребность цеха, где смотреть деньги, московские ' +
    'сутки. Зови, когда спрашивают «что значит…», «как работает…», ' +
    '«где посмотреть…» — то есть про УСТРОЙСТВО, а не про данные.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Тема вопроса своими словами' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(input) {
    const query = str(input, 'query') ?? '';
    const articles = searchKnowledge(query);
    return {
      data: articles.length
        ? articles.map((a) => ({ title: a.title, body: a.body }))
        : { found: false, hint: 'В справке ничего не нашлось по этому запросу' },
    };
  },
};

// ---------------------------------------------------------------------------
// Реестр
// ---------------------------------------------------------------------------

export const ASSISTANT_TOOLS: AssistantTool[] = [
  ordersSearch,
  orderGet,
  passportLocate,
  productionQueue,
  workshopNeeds,
  orderEstimate,
  docsLookup,
];

/**
 * Инструменты, доступные при включённых группах.
 *
 * Фильтр применяется ДО обращения к модели: выключенная группа не
 * попадает в запрос, поэтому её нельзя «выпросить» промптом.
 */
export function toolsForScopes(scopes: AssistantDataScope[]): AssistantTool[] {
  return ASSISTANT_TOOLS.filter(
    (t) => t.scope === null || scopes.includes(t.scope),
  );
}
