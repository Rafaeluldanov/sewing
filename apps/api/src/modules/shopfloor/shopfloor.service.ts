import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  OperationCategory,
  OrderStatus,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import type {
  ShopfloorDisplayDto,
  ShopfloorDisplayKpiDto,
  ShopfloorEquipmentKind,
  ShopfloorEquipmentStatus,
  ShopfloorEquipmentStatusDto,
  ShopfloorOrderOptionDto,
  ShopfloorStateDto,
  ShopfloorStateQuery,
} from '@sewing/shared/shopfloor';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  projectShopfloor,
  projectShopfloorDisplay,
  type DisplayProjectionPassport,
  type ProjectionPassport,
  type ProjectionSize,
} from './shopfloor-projection.js';

/**
 * Порог «нет активности» для статуса оборудования на `/shopfloor/display`.
 * Если у активной смены нет нового `OPERATION_SCAN` (или, для только что
 * открытой смены, прошло столько от `startedAt`) — индикатор окрашивается
 * жёлтым (`WARNING`). 15 минут выбраны эмпирически: средняя операция в
 * MVP занимает ~2–7 мин, длительнее — это уже подозрение на простой.
 * См. `ShopfloorService.listEquipmentStatus`.
 */
const WARNING_AFTER_MS = 15 * 60 * 1000;

/**
 * Сервис экрана «Цех» (Шаг 10 MVP).
 *
 * Не вводит ни новой таблицы, ни кэша — на каждый polling-запрос делает
 * один Prisma-запрос за паспортами активных заказов и считает проекцию
 * на месте. Это намеренно: нагрузка на MVP небольшая (≤ 50 планшетов,
 * polling 3 сек), а поддерживать материализованную витрину дорого
 * без серьёзной выгоды (см. ADR-0007 и ADR-0013).
 *
 * Контракт — `docs/api.md §11`. Бизнес-описание stage-маппинга —
 * `docs/adr/0013-shopfloor-stage-mapping.md` и `docs/flows.md §F11`.
 */
@Injectable()
export class ShopfloorService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------------

  async getState(query: ShopfloorStateQuery): Promise<ShopfloorStateDto> {
    const orderId = query.orderId;
    let orderFilter: Prisma.PassportWhereInput;
    let scopeLabel: string;
    let scope: 'ALL_ACTIVE' | 'ORDER';

    if (orderId) {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, number: true, status: true },
      });
      if (!order) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'ORDER_NOT_FOUND',
          message: 'Заказ не найден',
        });
      }
      scope = 'ORDER';
      scopeLabel = `Заказ № ${order.number}`;
      orderFilter = { orderId: order.id };
    } else {
      scope = 'ALL_ACTIVE';
      // Активные = всё, что не завершено и не отменено. На MVP в это
      // окно попадают `DRAFT` (паспорта могут быть выпущены только при
      // `IN_PRODUCTION`, см. F2, поэтому реально работает только этот
      // статус, но фильтр оставлен расширяемым).
      orderFilter = {
        order: {
          status: {
            notIn: [OrderStatus.DONE, OrderStatus.CANCELLED],
          },
        },
      };
      const activeOrders = await this.prisma.order.count({
        where: { status: { notIn: [OrderStatus.DONE, OrderStatus.CANCELLED] } },
      });
      scopeLabel = `Все активные заказы (${activeOrders})`;
    }

    const [passports, sizes] = await Promise.all([
      this.prisma.passport.findMany({
        where: orderFilter,
        select: {
          id: true,
          sizeId: true,
          qtyCut: true,
          qtyGood: true,
          qtyDefect: true,
          status: true,
          currentOperation: { select: { category: true } },
          // Все BoxItem текущего паспорта; реально на MVP их максимум один
          // (UNIQUE `(boxId, passportId)` + ADR-0011 §3 — один паспорт в
          // одну коробку), но запрашиваем массивом, чтобы spec был
          // устойчив к будущему расширению.
          boxItems: {
            select: { box: { select: { closedAt: true } } },
          },
        },
      }),
      this.prisma.size.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, code: true, sortOrder: true },
      }),
    ]);

    // Расчёт «свежих» терминальных событий ОТК/ВТО для derived-стадий
    // `QC_DONE` / `WTO_DONE` (см. ADR-0013):
    // оператор нажал «выполнено», но pipeline ещё не подхватил паспорт
    // следующим OPERATION_SCAN'ом. Нужен только для тех паспортов,
    // которые сейчас реально могут попасть в эти бакеты — `IN_PROGRESS`
    // + соответствующая категория текущей операции. Это держит запрос
    // узким даже на больших активных заказах. См. F11/F5/F6.
    const qcCandidateIds: string[] = [];
    const wtoCandidateIds: string[] = [];
    for (const p of passports) {
      if (p.status !== PassportStatus.IN_PROGRESS) continue;
      const cat = p.currentOperation?.category;
      if (cat === OperationCategory.QC) qcCandidateIds.push(p.id);
      else if (cat === OperationCategory.IRONING) wtoCandidateIds.push(p.id);
    }

    const candidateIds = [...qcCandidateIds, ...wtoCandidateIds];
    const freshQcPassedSet = new Set<string>();
    const freshWtoPassedSet = new Set<string>();
    if (candidateIds.length > 0) {
      // Один групповой запрос на оба derived-стейджа: типы взаимно
      // не пересекаются, фильтр по `passportId` сужает выборку до
      // нужных кандидатов, а `_max(createdAt)` даёт «последнюю» метку
      // каждого типа на паспорт без гонок (сортировка по времени
      // монотонна в рамках одного скан-сценария).
      const eventMaxes = await this.prisma.passportEvent.groupBy({
        by: ['passportId', 'type'],
        where: {
          passportId: { in: candidateIds },
          type: {
            in: [
              PassportEventType.QC_PASSED,
              PassportEventType.WTO_PASSED,
              PassportEventType.OPERATION_SCAN,
            ],
          },
        },
        _max: { createdAt: true },
      });
      const lastQc = new Map<string, Date>();
      const lastWto = new Map<string, Date>();
      const lastScan = new Map<string, Date>();
      for (const row of eventMaxes) {
        const at = row._max.createdAt;
        if (!at) continue;
        if (row.type === PassportEventType.QC_PASSED) {
          lastQc.set(row.passportId, at);
        } else if (row.type === PassportEventType.WTO_PASSED) {
          lastWto.set(row.passportId, at);
        } else if (row.type === PassportEventType.OPERATION_SCAN) {
          lastScan.set(row.passportId, at);
        }
      }
      for (const id of qcCandidateIds) {
        const qcAt = lastQc.get(id);
        if (!qcAt) continue;
        const scanAt = lastScan.get(id);
        if (!scanAt || qcAt > scanAt) freshQcPassedSet.add(id);
      }
      for (const id of wtoCandidateIds) {
        const wtoAt = lastWto.get(id);
        if (!wtoAt) continue;
        const scanAt = lastScan.get(id);
        if (!scanAt || wtoAt > scanAt) freshWtoPassedSet.add(id);
      }
    }

    const projInput: ProjectionPassport[] = passports.map((p) => ({
      sizeId: p.sizeId,
      qtyCut: p.qtyCut,
      qtyGood: p.qtyGood,
      qtyDefect: p.qtyDefect,
      status: p.status,
      currentOperationCategory: p.currentOperation?.category ?? null,
      hasOpenBox: p.boxItems.some((bi) => bi.box.closedAt === null),
      hasFreshQcPassed: freshQcPassedSet.has(p.id),
      hasFreshWtoPassed: freshWtoPassedSet.has(p.id),
    }));

    // Для среза по одному заказу — ограничиваем размеры теми, что есть
    // в `OrderItem` заказа (даже если по ним 0 паспортов): начальник
    // должен видеть «пустую строку» для размера, под который ничего
    // ещё не выпустили. Для среза по всем активным — наоборот, не
    // показываем все 21 размер из справочника, чтобы экран не был
    // загромождён, и оставляем только те, по которым реально есть
    // движение (см. `projectShopfloor`).
    let visibleSizes: ProjectionSize[] = [];
    if (orderId) {
      const items = await this.prisma.orderItem.findMany({
        where: { orderId },
        include: { size: true },
      });
      visibleSizes = items.map((i) => ({
        id: i.size.id,
        code: i.size.code,
        sortOrder: i.size.sortOrder,
      }));
    }

    const { rows, summary } = projectShopfloor({
      passports: projInput,
      sizes: visibleSizes,
    });

    // Дозаполнение: при scope = ORDER UI должен показать строку для
    // каждого размера заказа, даже если по нему ещё не выпустили ни
    // одного паспорта (иначе экран будет «прыгать» по мере выпуска).
    // Проекция отбрасывает «совсем пустые» строки — добавим их вручную.
    if (orderId && visibleSizes.length > 0) {
      const have = new Set(rows.map((r) => r.sizeId));
      for (const s of visibleSizes) {
        if (have.has(s.id)) continue;
        rows.push({
          sizeId: s.id,
          sizeCode: s.code,
          sizeSortOrder: s.sortOrder,
          qtyCut: 0,
          qtySewing: 0,
          qtyQc: 0,
          qtyQcDone: 0,
          qtyWto: 0,
          qtyWtoDone: 0,
          qtyPacking: 0,
          qtyFinished: 0,
          qtyDefect: 0,
        });
      }
      rows.sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
    }

    return {
      updatedAt: new Date().toISOString(),
      scope,
      orderId: orderId ?? null,
      scopeLabel,
      summary,
      rows,
    };
  }

  // -------------------------------------------------------------------------
  // ORDERS (выпадающий список «выберите заказ»)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // EQUIPMENT STATUS (для `/shopfloor/display` — Production Board)
  // -------------------------------------------------------------------------

  /**
   * Список всего активного оборудования с агрегированным статусом
   * «работает / простаивает / выключено». Намеренно положено в
   * shopfloor-модуль (а не в equipment), потому что:
   *
   *   - DISPLAY-роль не имеет доступа к `/api/equipment` (там
   *     `@Roles(SHOP_MANAGER, ADMIN)`), а добавлять её туда —
   *     значит расширять админский surface ради read-only витрины;
   *   - shopfloor уже отдаёт DISPLAY все остальные данные витрины
   *     (`/state`, `/orders`), и логика «активные смены сейчас» — это
   *     цеховая семантика, а не CRUD оборудования (см. ADR-0017
   *     §«scope of EquipmentService»).
   *
   * Вычисление статуса (см. `ShopfloorEquipmentStatus`):
   *   - `OFFLINE` — нет открытой `ShiftSession` (или `equipment.active = false`);
   *   - `ONLINE`  — есть открытая смена И последний `OPERATION_SCAN`
   *                 этого сотрудника (на любую операцию) свежее, чем
   *                 `WARNING_AFTER_MS` назад. Если смена только что
   *                 открыта (нет ни одного скана), считаем `ONLINE`
   *                 в течение `WARNING_AFTER_MS` от старта — швея
   *                 успевает «зайти» без преждевременной жёлтой плашки.
   *   - `WARNING` — смена открыта, но активности дольше порога нет.
   *
   * Один Prisma-запрос за оборудованием + один — за активными сменами,
   * + точечный groupBy по `OPERATION_SCAN` среди только тех сотрудников,
   * у которых сейчас открыта смена. Это пропорционально числу станков
   * (≈ десятки), а не глобальному объёму событий.
   */
  async listEquipmentStatus(): Promise<ShopfloorEquipmentStatusDto[]> {
    // Equipment и активные смены не зависят друг от друга — гоняем
    // их параллельно, чтобы display-эндпоинт не накапливал лишний
    // serial round-trip к БД на каждый polling-tick.
    const [equipment, activeShifts] = await Promise.all([
      this.prisma.equipment.findMany({
        orderBy: [{ displayNumber: 'asc' }, { code: 'asc' }],
        include: {
          // Тянем категории разрешённых операций — нужны для иконки на
          // `/shopfloor/display` (см. `pickEquipmentKind`). Это +1 join,
          // но он лёгкий: операций ≈ десяток, M2M узкий.
          allowedOperations: {
            where: { isActive: true },
            select: {
              operation: { select: { category: true } },
            },
          },
        },
      }),
      this.prisma.shiftSession.findMany({
        where: { endedAt: null },
        include: {
          employee: { select: { id: true, fullName: true } },
          operation: { select: { id: true, name: true } },
        },
      }),
    ]);

    // Один батч-запрос за «последним OPERATION_SCAN» по каждому
    // сотруднику с активной сменой. Берём событие любой операции —
    // нам важен сам факт «швея только что что-то отсканировала».
    const employeeIds = activeShifts.map((s) => s.employeeId);
    const lastScanByEmployee = new Map<string, Date>();
    if (employeeIds.length > 0) {
      const grouped = await this.prisma.passportEvent.groupBy({
        by: ['employeeId'],
        where: {
          type: PassportEventType.OPERATION_SCAN,
          employeeId: { in: employeeIds },
        },
        _max: { createdAt: true },
      });
      for (const row of grouped) {
        if (!row.employeeId || !row._max.createdAt) continue;
        lastScanByEmployee.set(row.employeeId, row._max.createdAt);
      }
    }

    const shiftByEquipment = new Map<string, (typeof activeShifts)[number]>();
    for (const s of activeShifts) {
      // На равных правах смена ↔ оборудование (партиал unique по
      // `(employeeId, endedAt IS NULL)` гарантирует уникальность по
      // сотруднику; на equipment теоретически могут «висеть» две —
      // оставляем самую свежую `startedAt`).
      const prev = shiftByEquipment.get(s.equipmentId);
      if (!prev || prev.startedAt < s.startedAt) {
        shiftByEquipment.set(s.equipmentId, s);
      }
    }

    const now = Date.now();
    return equipment.map((eq): ShopfloorEquipmentStatusDto => {
      const shift = shiftByEquipment.get(eq.id) ?? null;
      let status: ShopfloorEquipmentStatus = 'OFFLINE';
      let lastActivityAt: string | null = null;
      if (eq.active && shift) {
        const lastScan = lastScanByEmployee.get(shift.employeeId) ?? null;
        // «Активность» считаем по последнему скану в рамках текущей
        // смены: события до её старта не релевантны (швея могла
        // сканировать утром, а потом уйти и открыть новую смену).
        const activityAt =
          lastScan && lastScan >= shift.startedAt ? lastScan : null;
        const referenceAt = activityAt ?? shift.startedAt;
        const ageMs = now - referenceAt.getTime();
        status = ageMs <= WARNING_AFTER_MS ? 'ONLINE' : 'WARNING';
        lastActivityAt = activityAt ? activityAt.toISOString() : null;
      }
      const kind = pickEquipmentKind(
        eq.allowedOperations.map((ao) => ao.operation.category),
      );
      return {
        id: eq.id,
        code: eq.code,
        name: eq.name,
        displayNumber: eq.displayNumber,
        active: eq.active,
        status,
        kind,
        employeeName: shift?.employee.fullName ?? null,
        operationName: shift?.operation.name ?? null,
        shiftStartedAt: shift ? shift.startedAt.toISOString() : null,
        lastActivityAt,
      };
    });
  }

  // -------------------------------------------------------------------------
  // DISPLAY SUMMARY (одно RSC + polling-подключение для большого монитора)
  // -------------------------------------------------------------------------

  /**
   * Единый агрегированный срез для `/shopfloor/display`.
   *
   * Даёт фронту готовый KPI-блок, матрицу «цвет × размер × stage» и
   * статусы оборудования за один запрос. Раньше экран собирал то же
   * самое из 4 endpoint'ов и довычислял проекцию по цветам на клиенте.
   * Перенос агрегации на backend:
   *   - снимает «гонку» между KPI и матрицей (был кейс «выпустили
   *     паспорт, KPI обновился, а матрица отстала на 1 цикл»);
   *   - убирает с клиента дорогую группировку (десятки паспортов
   *     × шесть стадий × N размеров);
   *   - даёт стабильный read-only DTO под смоук-/integration-тесты.
   *
   * Менеджерский `/shopfloor` не трогаем: он по-прежнему берёт
   * `/shopfloor/state` и `/shopfloor/orders`. Контракты не пересекаются.
   */
  async getDisplaySummary(): Promise<ShopfloorDisplayDto> {
    // Узкий фильтр: те же активные заказы, что и в `/shopfloor/state`
    // в режиме ALL_ACTIVE. Defect tally и stage-buckets считает
    // `projectShopfloorDisplay`.
    const orderFilter: Prisma.PassportWhereInput = {
      order: {
        status: {
          notIn: [OrderStatus.DONE, OrderStatus.CANCELLED],
        },
      },
    };

    const [passports, sizes, openSewingShifts] = await Promise.all([
      this.prisma.passport.findMany({
        where: orderFilter,
        select: {
          id: true,
          sizeId: true,
          color: true,
          qtyCut: true,
          qtyGood: true,
          qtyDefect: true,
          status: true,
          // Текущий исполнитель — нужен для fallback'а sewing-колонки
          // (см. `assignedShiftSewingOperation*` в проекции). После
          // `issueToEmployee` `currentOperationId` ещё указывает на
          // CUT_DIVISION, а реальная sewing-операция швеи живёт в её
          // открытой `ShiftSession`. Один скаляр в select — стоимость
          // нулевая.
          currentEmployeeId: true,
          // Тянем `id/name/category/sortOrder` текущей операции — нужны
          // не только для category-бакета, но и для детализации стадии
          // «Пошив» по конкретным sewing-операциям (Оверлок 1, Киперка
          // и т. п. — см. `ShopfloorDisplayDto.sewingColumns` и
          // `projectShopfloorDisplay`). Один join, +3 узких поля —
          // запрос остаётся столь же лёгким, как раньше.
          currentOperation: {
            select: {
              id: true,
              name: true,
              category: true,
              sortOrder: true,
            },
          },
          boxItems: {
            select: { box: { select: { closedAt: true } } },
          },
        },
      }),
      this.prisma.size.findMany({
        select: { id: true, code: true, sortOrder: true },
      }),
      // Открытые смены на sewing-операциях — нужны как fallback-источник
      // sewing-колонки для паспортов, которые швея уже «приняла в работу»
      // (`issueToEmployee`), но ещё не успела отдельно отсканировать на
      // конкретную операцию: на этом шаге `Passport.currentOperationId`
      // всё ещё CUTTING (CUT_DIVISION), а доменно правильная sewing-
      // операция лежит в её активной `ShiftSession.operationId`. Без
      // этого fallback'а такие паспорта валятся в pending-колонку
      // «Ожидает», хотя физически уже находятся на конкретном станке
      // (Оверлок 1 / Распошив / Киперка).
      //
      // Узкий фильтр `endedAt = null` + `operation.category = SEWING`:
      // не тянем смены ОТК/ВТО/упаковки (там currentOperation уже
      // правильная) и завершённые — это держит выборку маленькой
      // даже на длинной истории смен.
      this.prisma.shiftSession.findMany({
        where: {
          endedAt: null,
          operation: { category: OperationCategory.SEWING },
        },
        select: {
          employeeId: true,
          operation: {
            select: { id: true, name: true, sortOrder: true },
          },
        },
      }),
    ]);

    // Тот же расчёт «свежих» терминальных событий ОТК/ВТО, что и в
    // `getState` — повторяем здесь, чтобы display-summary жил отдельно
    // от scope-логики `getState` и не тащил с собой OrderItem-фильтр
    // «видимых размеров». См. `getState` для более длинного коммента.
    const qcCandidateIds: string[] = [];
    const wtoCandidateIds: string[] = [];
    for (const p of passports) {
      if (p.status !== PassportStatus.IN_PROGRESS) continue;
      const cat = p.currentOperation?.category;
      if (cat === OperationCategory.QC) qcCandidateIds.push(p.id);
      else if (cat === OperationCategory.IRONING) wtoCandidateIds.push(p.id);
    }
    const candidateIds = [...qcCandidateIds, ...wtoCandidateIds];

    // KPI «Выпущено сегодня» — Σ qtyGood по PACKED-событиям за UTC-сегодня.
    // Не зависит ни от candidateIds, ни от equipment, поэтому уезжает
    // в общий `Promise.all` ниже параллельно с ними.
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);

    // Три независимых запроса гоняем параллельно одним `Promise.all`:
    //   1) eventMaxes — derived QC_DONE/WTO_DONE для матрицы;
    //   2) packedToday — KPI «Выпущено сегодня»;
    //   3) listEquipmentStatus — плитки оборудования (внутри тоже
    //      параллелизован).
    // Раньше эти три запроса шли последовательно (eventMaxes →
    // packedToday → equipment), что добавляло 2 лишних DB round-trip'а
    // в latency каждого polling-цикла. Контракт ответа /api/shopfloor/display
    // не меняется — только порядок исполнения.
    // Тип возвращаемого groupBy-ряда вынесен в alias, чтобы fallback
    // `Promise.resolve([])` сохранял тот же type-shape без сложных
    // обходов overload'ов Prisma-клиента.
    type EventMaxRow = {
      passportId: string;
      type: PassportEventType;
      _max: { createdAt: Date | null };
    };
    const eventMaxesPromise =
      candidateIds.length > 0
        ? (this.prisma.passportEvent.groupBy({
            by: ['passportId', 'type'],
            where: {
              passportId: { in: candidateIds },
              type: {
                in: [
                  PassportEventType.QC_PASSED,
                  PassportEventType.WTO_PASSED,
                  PassportEventType.OPERATION_SCAN,
                ],
              },
            },
            _max: { createdAt: true },
          }) as unknown as Promise<EventMaxRow[]>)
        : Promise.resolve<EventMaxRow[]>([]);

    const packedTodayPromise = this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.PACKED,
        createdAt: { gte: startOfDayUtc },
      },
      select: {
        // Узкий select: нам нужен только `qtyGood` паспорта для суммы.
        // Никаких лишних join'ов / include — это держит latency
        // KPI-запроса предсказуемым.
        passport: { select: { qtyGood: true } },
      },
    });

    const equipmentPromise = this.listEquipmentStatus();

    const [eventMaxes, packedToday, equipment] = await Promise.all([
      eventMaxesPromise,
      packedTodayPromise,
      equipmentPromise,
    ]);

    const freshQcPassedSet = new Set<string>();
    const freshWtoPassedSet = new Set<string>();
    if (eventMaxes.length > 0) {
      const lastQc = new Map<string, Date>();
      const lastWto = new Map<string, Date>();
      const lastScan = new Map<string, Date>();
      for (const row of eventMaxes) {
        const at = row._max.createdAt;
        if (!at) continue;
        if (row.type === PassportEventType.QC_PASSED) lastQc.set(row.passportId, at);
        else if (row.type === PassportEventType.WTO_PASSED)
          lastWto.set(row.passportId, at);
        else if (row.type === PassportEventType.OPERATION_SCAN)
          lastScan.set(row.passportId, at);
      }
      for (const id of qcCandidateIds) {
        const qcAt = lastQc.get(id);
        if (!qcAt) continue;
        const scanAt = lastScan.get(id);
        if (!scanAt || qcAt > scanAt) freshQcPassedSet.add(id);
      }
      for (const id of wtoCandidateIds) {
        const wtoAt = lastWto.get(id);
        if (!wtoAt) continue;
        const scanAt = lastScan.get(id);
        if (!scanAt || wtoAt > scanAt) freshWtoPassedSet.add(id);
      }
    }

    // Индекс «сотрудник → его открытая sewing-смена»; используется как
    // fallback-источник sewing-колонки, см. блок-комментарий выше у
    // запроса `openSewingShifts` и поля `assignedShiftSewingOperation*`
    // в `DisplayProjectionPassport`. На сотрудника физически открыта
    // не более одной смены (UNIQUE `(employeeId, endedAt IS NULL)`),
    // так что Map по `employeeId` без коллизий.
    const sewingShiftByEmployee = new Map<
      string,
      { id: string; name: string; sortOrder: number }
    >();
    for (const s of openSewingShifts) {
      sewingShiftByEmployee.set(s.employeeId, {
        id: s.operation.id,
        name: s.operation.name,
        sortOrder: s.operation.sortOrder,
      });
    }

    const projInput: DisplayProjectionPassport[] = passports.map((p) => {
      const assignedShift = p.currentEmployeeId
        ? (sewingShiftByEmployee.get(p.currentEmployeeId) ?? null)
        : null;
      return {
        sizeId: p.sizeId,
        color: p.color,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        qtyDefect: p.qtyDefect,
        status: p.status,
        currentOperationCategory: p.currentOperation?.category ?? null,
        currentOperationId: p.currentOperation?.id ?? null,
        currentOperationName: p.currentOperation?.name ?? null,
        currentOperationSortOrder: p.currentOperation?.sortOrder ?? null,
        assignedShiftSewingOperationId: assignedShift?.id ?? null,
        assignedShiftSewingOperationName: assignedShift?.name ?? null,
        assignedShiftSewingOperationSortOrder: assignedShift?.sortOrder ?? null,
        hasOpenBox: p.boxItems.some((bi) => bi.box.closedAt === null),
        hasFreshQcPassed: freshQcPassedSet.has(p.id),
        hasFreshWtoPassed: freshWtoPassedSet.has(p.id),
      };
    });

    const sizeMeta = new Map<string, ProjectionSize>();
    for (const s of sizes)
      sizeMeta.set(s.id, { id: s.id, code: s.code, sortOrder: s.sortOrder });

    const { colors, totals, sewingColumns } = projectShopfloorDisplay(
      { passports: projInput },
      sizeMeta,
    );

    // KPI «Выпущено сегодня» — Σ qtyGood по PACKED-событиям UTC-сегодня
    // (запрос ушёл в `Promise.all` выше). Отдельный запрос (а не из
    // `dashboard.production`), чтобы display не зависел от dashboard-
    // модуля и его периодов.
    const producedToday = packedToday.reduce(
      (s, e) => s + e.passport.qtyGood,
      0,
    );

    // KPI «В работе» — всё, что внутри pipeline (CUT уже распределили
    // как «ждёт», поэтому inWork считается без него и без FINISHED).
    // Это согласуется с подписью UI «В работе» / «Ждёт».
    const inWork =
      totals.qtySewing +
      totals.qtyQc +
      totals.qtyQcDone +
      totals.qtyWto +
      totals.qtyWtoDone +
      totals.qtyPacking;

    const kpi: ShopfloorDisplayKpiDto = {
      producedToday,
      inWork,
      waiting: totals.qtyCut,
      qc: totals.qtyQc + totals.qtyQcDone,
      wto: totals.qtyWto + totals.qtyWtoDone,
      packing: totals.qtyPacking,
      finished: totals.qtyFinished,
      defect: totals.qtyDefect,
    };

    // `equipment` уже посчитан в общем `Promise.all` выше — никаких
    // дополнительных DB round-trip'ов на этом этапе.
    return {
      updatedAt: new Date().toISOString(),
      kpi,
      colors,
      totals,
      sewingColumns,
      equipment,
    };
  }

  // -------------------------------------------------------------------------
  // ACTIVE ORDERS (выпадающий список «выберите заказ»)
  // -------------------------------------------------------------------------

  async listActiveOrders(): Promise<ShopfloorOrderOptionDto[]> {
    const rows = await this.prisma.order.findMany({
      where: { status: { notIn: [OrderStatus.DONE, OrderStatus.CANCELLED] } },
      include: {
        items: { include: { product: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((o) => {
      const firstItem = o.items[0];
      const product = firstItem?.product ?? null;
      const qtyPlanTotal = o.items.reduce((s, i) => s + i.qtyPlan, 0);
      return {
        id: o.id,
        number: o.number,
        // На MVP активные = `DRAFT | IN_PRODUCTION`; узким union'ом
        // фиксируем это в DTO.
        status: o.status as 'DRAFT' | 'IN_PRODUCTION',
        productName: product?.name ?? null,
        color: o.color ?? product?.color ?? null,
        qtyPlanTotal,
        createdAt: o.createdAt.toISOString(),
      };
    });
  }
}

/**
 * Выбор «доминирующей» категории оборудования для иконки на
 * `/shopfloor/display`. Приоритет — по визуальной значимости в цеху:
 * швейные машины и раскройные столы — основной поток; QC/IRONING/
 * PACKING встречаются реже и хорошо различимы по своим иконкам.
 *
 * `OTHER` — fallback, когда у оборудования вообще нет разрешённых
 * операций (свежесозданное в админке без настройки).
 */
const EQUIPMENT_KIND_PRIORITY: ShopfloorEquipmentKind[] = [
  'SEWING',
  'CUTTING',
  'IRONING',
  'QC',
  'PACKING',
];

function pickEquipmentKind(
  categories: OperationCategory[],
): ShopfloorEquipmentKind {
  if (categories.length === 0) return 'OTHER';
  const set = new Set<ShopfloorEquipmentKind>(
    categories as ShopfloorEquipmentKind[],
  );
  for (const k of EQUIPMENT_KIND_PRIORITY) {
    if (set.has(k)) return k;
  }
  return 'OTHER';
}
