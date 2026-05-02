import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  MasterCallStatus,
  OperationCategory,
  OrderStatus,
  PassportEventType,
  PassportStatus,
  Role,
} from '@prisma/client';
import type {
  ShopfloorDisplayDto,
  ShopfloorDisplayKpiDto,
  ShopfloorDisplayQuery,
  ShopfloorDisplayRouteOperationDto,
  ShopfloorDisplayRouteSizeRowDto,
  ShopfloorEquipmentKind,
  ShopfloorEquipmentStatus,
  ShopfloorEquipmentStatusDto,
  ShopfloorOrderOptionDto,
  ShopfloorOrphanMasterCallDto,
  ShopfloorStateDto,
  ShopfloorStateQuery,
} from '@sewing/shared/shopfloor';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  projectShopfloor,
  projectShopfloorDisplay,
  type DisplayProjectionPassport,
  type ProjectionPassport,
  type ProjectionSize,
} from './shopfloor-projection.js';

/**
 * Семантика статуса оборудования на `/shopfloor/display` (TV-витрина):
 *
 *   - `ONLINE`  — оборудование активно, есть открытая смена И на нём
 *                 прямо сейчас лежит хотя бы один паспорт в работе
 *                 (`currentSizes.length > 0`). Только этот статус
 *                 окрашивает плитку зелёным — оператор/начальник видит
 *                 «реально шьётся».
 *   - `WARNING` — оборудование активно, есть открытая смена, но
 *                 паспорта в работе на нём нет (швея зашла, но ещё не
 *                 взяла крой / только что закончила и ждёт следующий).
 *                 Жёлтая плитка — «занят, но простаивает».
 *   - `OFFLINE` — нет открытой смены / `Equipment.active = false`.
 *                 Серая плитка — «свободен/выключен».
 *
 * Раньше использовался time-based порог (15 минут по последнему
 * `OPERATION_SCAN` сотрудника), но он давал ложно зелёный сигнал
 * на TV: смена открыта, паспортов нет, а станок «зелёный» первые
 * 15 минут. Бизнес хочет, чтобы зелёный означал РОВНО «сейчас
 * шьётся» — а это однозначный признак из `currentSizes` (того же
 * источника, что и колонка ▶ в split-таблице sewing-route).
 *
 * Поле `lastActivityAt` в DTO сохранили: оно по-прежнему даёт
 * диагностический ISO-timestamp последнего `OPERATION_SCAN` сотрудника
 * для UI-подсказок и логов, просто больше не управляет цветом плитки.
 *
 * См. `ShopfloorService.listEquipmentStatus` и `docs/screens.md §9a.5`.
 */

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
          // Нужен `bucketOf` для отделения «issued, ещё не scanned»
          // (CUTTING + employee != null → SEWING) от «rolled-back to
          // CUT мастером» (CUTTING + employee == null → CUT). Без
          // этого поля master-rollback на крой исчезает с экрана.
          currentEmployeeId: true,
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
      currentEmployeeId: p.currentEmployeeId,
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
   * Вычисление статуса (см. `ShopfloorEquipmentStatus` и блок-
   * комментарий выше):
   *
   *   - `OFFLINE` — `equipment.active = false` ИЛИ нет открытой
   *                 `ShiftSession` на станке. Серая плитка.
   *   - `WARNING` — есть открытая смена, но `currentSizes.length === 0`
   *                 (швея зашла, но паспорта в работе нет). Жёлтая.
   *   - `ONLINE`  — есть открытая смена И `currentSizes.length > 0`
   *                 (паспорт реально на станке, зелёная плитка).
   *
   * `currentSizes` считается выше единым проходом по паспортам и
   * включает assigned-shift fallback (issueToEmployee до первого
   * OPERATION_SCAN), поэтому статус ONLINE появляется ровно тогда,
   * когда матричная sewing-колонка ▶ показывает на этом оборудовании
   * хотя бы одну штуку. Это и закрывает кейс D из ТЗ
   * (route-WIP после issue до scan).
   *
   * Один Prisma-запрос за оборудованием + один — за активными сменами,
   * + точечный groupBy по `OPERATION_SCAN` среди только тех сотрудников,
   * у которых сейчас открыта смена (для диагностического `lastActivityAt`,
   * статус сам по себе от `OPERATION_SCAN` больше не зависит). Это
   * пропорционально числу станков (≈ десятки), а не глобальному объёму
   * событий.
   */
  async listEquipmentStatus(): Promise<ShopfloorEquipmentStatusDto[]> {
    const { equipment } = await this.loadEquipmentAndOpenMasterCalls();
    return equipment;
  }

  /**
   * Внутренний батч-загрузчик: equipment-плитки + открытые
   * master-calls в одном «снимке».
   *
   * Сделано отдельным методом, чтобы `getDisplaySummary` мог одним
   * проходом получить и `equipment` (с уже расставленным
   * `hasOpenMasterCall`), и `orphanMasterCalls` (вызовы без
   * `equipmentId`), не делая два независимых запроса к
   * `MasterCall` (см. `apps/api/src/modules/master-calls/*`).
   *
   * Поведение `listEquipmentStatus` снаружи не меняется — публичный
   * метод просто берёт `equipment` из этого helper'а.
   */
  private async loadEquipmentAndOpenMasterCalls(): Promise<{
    equipment: ShopfloorEquipmentStatusDto[];
    orphanMasterCalls: ShopfloorOrphanMasterCallDto[];
  }> {
    const [equipment, activeShifts, openMasterCalls] = await Promise.all([
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
          // `category` нужен для fallback'а `currentSizes` (см. ниже):
          // на sewing-смене допускается, что у только что выданного
          // паспорта `currentOperationId` ещё CUT_DIVISION
          // (CUTTING-категория), пока швея не сделала первый
          // OPERATION_SCAN. На QC/IRONING/PACKING-сменах такого
          // расхождения не бывает — там `currentOperationId`
          // выставляется тем же сценарием, что открывает смену.
          operation: { select: { id: true, name: true, category: true } },
        },
      }),
      // Открытые вызовы мастера. Нужны параллельно с equipment, чтобы:
      //   1) проставить `hasOpenMasterCall` на конкретной плитке станка,
      //      где сейчас стоит сотрудник, позвавший мастера;
      //   2) сформировать `orphanMasterCalls` — вызовы без `equipmentId`,
      //      которые UI показывает отдельным блоком (см. `docs/screens.md
      //      §9a`, `docs/flows.md §«Вызов мастера»`).
      // Запрос узкий, sort'имся по `createdAt asc` — UI рисует «самый
      // давний — выше».
      this.prisma.masterCall.findMany({
        where: { status: MasterCallStatus.OPEN },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          equipmentId: true,
          createdAt: true,
          employee: { select: { fullName: true } },
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

    // ----- Текущие размеры на оборудовании (`currentSizes`) -----
    //
    // «Физически сейчас на станке этой смены». Тот же fallback, что
    // использует sewing split-таблица (`resolveCurrentSewingOperationId`
    // / `sewingColumnKeyOf`), иначе экран расходится: split-матрица
    // показывает 12 шт M на «Оверлок 1» через assignedShift fallback,
    // а equipment-плитка — пусто, потому что у паспорта ещё
    // `currentOperationId = CUT_DIVISION` после `issueToEmployee`.
    //
    // Правило по одному паспорту, привязанному к смене (по
    // `currentEmployeeId === shift.employeeId`):
    //   1) `currentOperationId === shift.operationId` — однозначное
    //      совпадение, паспорт уже отсканирован на эту операцию;
    //   2) shift.operation — категории `SEWING` — assigned-shift
    //      fallback: паспорт уже принят швеёй (`issueToEmployee`),
    //      `currentOperationId` ещё CUT_DIVISION (CUTTING) до первого
    //      `OPERATION_SCAN`, но физически он на станке этой смены;
    //   3) иначе — паспорт не учитывается (не на этом станке).
    //
    // Жёсткие гарды против «ложных размеров»:
    //   - `status === IN_PROGRESS`;
    //   - `currentEmployeeId !== null` (после `complete*` исполнитель
    //     снят, паспорт лежит «в корзине», не на станке);
    //   - паспорт привязан ровно к одной смене через employeeId
    //     (UNIQUE `(employeeId, endedAt IS NULL)` на `ShiftSession`).
    //
    // Один батчевый запрос по `currentEmployeeId IN (employeeIds)` —
    // масштабируется по числу открытых смен (десятки). Раскладку
    // по сменам делаем in-memory; на QC/IRONING/PACKING-сменах
    // strict (currentOperationId === shift.operationId), на
    // sewing-сменах — strict ИЛИ assigned-shift fallback.
    const sizesByEquipment = new Map<
      string,
      Array<{ code: string; sortOrder: number }>
    >();
    if (employeeIds.length > 0) {
      const passportsForSizes = await this.prisma.passport.findMany({
        where: {
          status: PassportStatus.IN_PROGRESS,
          currentEmployeeId: { in: employeeIds },
        },
        select: {
          currentEmployeeId: true,
          currentOperationId: true,
          size: { select: { code: true, sortOrder: true } },
        },
      });
      // Группируем паспорта по `currentEmployeeId`, чтобы потом для
      // каждой смены пройти только её подмножество.
      const passportsByEmployee = new Map<
        string,
        typeof passportsForSizes
      >();
      for (const p of passportsForSizes) {
        if (!p.currentEmployeeId) continue;
        let arr = passportsByEmployee.get(p.currentEmployeeId);
        if (!arr) {
          arr = [];
          passportsByEmployee.set(p.currentEmployeeId, arr);
        }
        arr.push(p);
      }
      for (const [equipmentId, shift] of shiftByEquipment) {
        const employeePassports = passportsByEmployee.get(shift.employeeId);
        if (!employeePassports || employeePassports.length === 0) continue;
        const isSewingShift =
          shift.operation.category === OperationCategory.SEWING;
        const arr: Array<{ code: string; sortOrder: number }> = [];
        for (const p of employeePassports) {
          const matchesOperation =
            p.currentOperationId === shift.operationId;
          // Sewing-смена принимает паспорта по employeeId независимо
          // от текущей операции — assigned-shift fallback для
          // «выдан, ещё не отсканирован». Не-sewing-смены (QC/ВТО/
          // упаковка) идут только строгим совпадением операции.
          if (!matchesOperation && !isSewingShift) continue;
          if (!arr.some((s) => s.code === p.size.code)) {
            arr.push({ code: p.size.code, sortOrder: p.size.sortOrder });
          }
        }
        if (arr.length > 0) sizesByEquipment.set(equipmentId, arr);
      }
    }

    // Set `equipmentId` оборудования с открытым вызовом мастера —
    // используется ниже для плагин-флага `hasOpenMasterCall` на плитке.
    const masterCallEquipmentIds = new Set<string>();
    const orphanMasterCalls: ShopfloorOrphanMasterCallDto[] = [];
    for (const c of openMasterCalls) {
      if (c.equipmentId) {
        masterCallEquipmentIds.add(c.equipmentId);
      } else {
        orphanMasterCalls.push({
          id: c.id,
          createdAt: c.createdAt.toISOString(),
          employeeName: c.employee.fullName,
        });
      }
    }

    const equipmentDtos = equipment.map((eq): ShopfloorEquipmentStatusDto => {
      const shift = shiftByEquipment.get(eq.id) ?? null;
      // Размеры, реально шьющиеся сейчас на станке. Источник —
      // `sizesByEquipment`, посчитанный единым проходом по паспортам
      // активных смен (см. блок-комментарий выше про fallback). Для
      // OFFLINE / без смены — гарантированно пустой массив. Считаем
      // ДО status, потому что новая семантика статуса опирается на
      // его длину, а не на время последнего скана.
      const sizesArr = shift ? (sizesByEquipment.get(eq.id) ?? []) : [];
      const currentSizes = sizesArr
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((s) => s.code);

      // Новая бизнес-семантика статуса для TV-витрины (см. блок-
      // комментарий выше):
      //   - нет смены / станок выключен                → OFFLINE;
      //   - смена есть, но паспортов на станке нет     → WARNING;
      //   - смена есть и хотя бы один паспорт в работе → ONLINE.
      // Никаких time-based порогов: зелёный плитки == «реально
      // шьётся прямо сейчас», ровно тот же признак, что подсвечивает
      // ▶-колонка sewing-route матрицы.
      let status: ShopfloorEquipmentStatus;
      if (!eq.active || !shift) {
        status = 'OFFLINE';
      } else if (currentSizes.length > 0) {
        status = 'ONLINE';
      } else {
        status = 'WARNING';
      }

      // `lastActivityAt` оставлен для диагностики (и обратной
      // совместимости DTO), но больше не управляет цветом плитки.
      // Берём последний `OPERATION_SCAN` сотрудника в рамках текущей
      // смены — события до её старта не релевантны (швея могла
      // сканировать утром, потом уйти и открыть новую смену).
      let lastActivityAt: string | null = null;
      if (shift) {
        const lastScan = lastScanByEmployee.get(shift.employeeId) ?? null;
        if (lastScan && lastScan >= shift.startedAt) {
          lastActivityAt = lastScan.toISOString();
        }
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
        currentSizes,
        hasOpenMasterCall: masterCallEquipmentIds.has(eq.id),
      };
    });

    return { equipment: equipmentDtos, orphanMasterCalls };
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
  async getDisplaySummary(
    query: ShopfloorDisplayQuery = {},
    user?: AuthPrincipal,
  ): Promise<ShopfloorDisplayDto> {
    // Узкий фильтр: те же активные заказы, что и в `/shopfloor/state`
    // в режиме ALL_ACTIVE. Defect tally и stage-buckets считает
    // `projectShopfloorDisplay`.
    //
    // Решение по подразделению (см. `docs/display-board.md`):
    //   1) явный `query.divisionCode` побеждает всё. Это любая
    //      пользовательская строка `CompanyDivision.code`;
    //   2) иначе, если запрос пришёл от роли `DISPLAY` — пытаемся
    //      найти `DisplayScreenConfig` по `employeeId` и применить
    //      привязанное подразделение оттуда (`companyDivision.code`).
    //      Это и есть «дисплей сам знает своё подразделение»
    //      (см. `docs/screens.md §10e`, `docs/api.md §11`). Конфиг
    //      с `isActive = false` сознательно игнорируем — мягкий
    //      выключатель экрана, менеджер временно сделал ему
    //      «общий» агрегат;
    //   3) иначе — никакого фильтра.
    //
    // Filter применяется через `Order.companyDivision.code = …`.
    //
    // Equipment status (`listEquipmentStatus`) сознательно НЕ
    // фильтруем по подразделению: оборудование не принадлежит
    // подразделению, и одни и те же станки могут шить разные заказы
    // между сменами.
    const divisionCode = await this.resolveDisplayDivisionCode(query, user);

    const orderFilter: Prisma.PassportWhereInput = {
      order: {
        status: {
          notIn: [OrderStatus.DONE, OrderStatus.CANCELLED],
        },
        ...(divisionCode
          ? buildOrderDivisionFilter(divisionCode)
          : {}),
      },
    };

    const [passports, sizes, openSewingShifts] = await Promise.all([
      this.prisma.passport.findMany({
        where: orderFilter,
        select: {
          id: true,
          // `orderId` нужен под маршрутный sewing-блок (`sewingRoute`):
          // сравниваем `currentRouteStepIndex` с `OrderRouteStep.index`
          // в рамках того же заказа. Один скаляр, никаких join'ов.
          orderId: true,
          // Soft-route индекс маршрута паспорта (см. `Passport.
          // currentRouteStepIndex`). `null` означает «маршрут у заказа
          // не зафиксирован / шаг ещё не известен» — такие паспорта
          // в `sewingRoute` не участвуют (ни inProgress, ни done).
          currentRouteStepIndex: true,
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

    const equipmentPromise = this.loadEquipmentAndOpenMasterCalls();

    // Снимки маршрутов всех АКТИВНЫХ заказов (не только тех, у кого
    // уже есть паспорта). Тянем только sewing-шаги (фильтр по
    // `operation.category`), чтобы в payload не уезжали QC/IRONING/
    // PACKING — они не нужны для `sewingRoute` (по контракту блок
    // строится только по sewing-операциям, см.
    // `ShopfloorDisplayDto.sewingRoute`).
    //
    // ВАЖНО: список orderId берём из `Order` напрямую с тем же
    // фильтром, что и `passports` (status notIn DONE/CANCELLED +
    // optional division). Раньше использовались только orderId
    // живых паспортов (`passports.map(p.orderId)`), и это давало
    // регресс: активный заказ без паспортов (cold start, все
    // CANCELLED) исчезал из sewingRoute, потому что его routeSteps
    // не запрашивались. Инвариант экрана: «есть активный order +
    // route snapshot → его операции ОБЯЗАНЫ быть в sewingRoute».
    //
    // Параллельно тянем `OrderItem` каждого активного заказа: эти
    // размеры используются как fallback в `buildSewingRoute`, когда
    // у заказа нет ни одного «живого» паспорта (все PACKED/CANCELLED
    // или ещё не выпущены) — иначе блок операции получает rows=[]
    // и оператор не понимает, под какой размер ждать загрузку.
    const activeOrdersPromise = this.prisma.order.findMany({
      where: {
        status: { notIn: [OrderStatus.DONE, OrderStatus.CANCELLED] },
        ...(divisionCode
          ? buildOrderDivisionFilter(divisionCode)
          : {}),
      },
      select: {
        id: true,
        items: { select: { sizeId: true } },
      },
    });

    const [eventMaxes, packedToday, equipmentBundle, activeOrders] = await Promise.all([
      eventMaxesPromise,
      packedTodayPromise,
      equipmentPromise,
      activeOrdersPromise,
    ]);

    // routeSteps зависят от списка активных orderId — гоняем отдельным
    // round-trip'ом после `activeOrdersPromise`. Это +1 sequential
    // запрос относительно прежней схемы, но он узкий (фильтр уже по
    // конкретному набору ID + категории SEWING) и держит инвариант
    // «весь маршрут активных заказов». Если активных заказов нет —
    // сразу резолвим [].
    const orderIdsForRoute = activeOrders.map((o) => o.id);
    const routeSteps =
      orderIdsForRoute.length > 0
        ? await this.prisma.orderRouteStep.findMany({
            where: {
              orderId: { in: orderIdsForRoute },
              operation: { category: OperationCategory.SEWING },
            },
            select: {
              orderId: true,
              index: true,
              operation: {
                select: { id: true, name: true, sortOrder: true },
              },
            },
          })
        : [];

    // Fallback `Map<orderId, Set<sizeId>>` для `buildSewingRoute`.
    // Используется, когда у заказа в текущем срезе нет ни одного
    // живого (не CANCELLED, не PACKED) паспорта, но операция всё
    // равно должна быть видна с пустыми ячейками 0/0 для размеров
    // самого заказа. См. блок-комментарий у `buildSewingRoute`
    // про size fallback.
    const orderItemSizes = new Map<string, Set<string>>();
    for (const o of activeOrders) {
      const set = new Set<string>();
      for (const it of o.items) set.add(it.sizeId);
      orderItemSizes.set(o.id, set);
    }
    const equipment = equipmentBundle.equipment;
    const orphanMasterCalls = equipmentBundle.orphanMasterCalls;

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
        currentEmployeeId: p.currentEmployeeId,
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

    // ----- Sewing route block (маршрутный pass через sewing-операции) -----
    //
    // Display показывает ВЕСЬ маршрут sewing-операций активных заказов
    // (даже если по какой-то операции сейчас 0/0) и ТЕКУЩЕЕ накопление
    // WIP на каждой из них (а НЕ исторический факт «когда-то выполнено»).
    // Семантика split-колонок (см. также `docs/screens.md §9a.4`):
    //
    //   ▶ inProgress = «паспорт сейчас физически в работе на этой
    //                  sewing-операции» (источник — тот же resolver,
    //                  что использует матрица; см.
    //                  `resolveCurrentSewingOperationId` ниже);
    //   ✔ done       = «паспорт завершён на этой sewing-операции и
    //                  ещё НЕ перешёл к следующему шагу маршрута»
    //                  (ожидает выдачи следующему исполнителю —
    //                  буфер между текущим и следующим step'ом).
    //
    // Полный маршрут видим намеренно: bottleneck-эвристка на UI
    // подсвечивает СЛЕДУЮЩУЮ операцию (`processSplits[i + 1]`).
    // Если перед пустой Киперкой на Оверлоке накопился ✔=32 — Киперка
    // должна остаться видна на матрице с rows=0/0, иначе подсвечивать
    // нечего и сигнал «узкое место — дальше» теряется.
    //
    // Ключевое отличие от старой логики: больше нет накопления
    // `currentRouteStepIndex > step.index → done`. Если паспорт
    // уже двинулся дальше по маршруту (его взял следующий
    // sewing-step или ОТК) — старая операция БОЛЬШЕ ЕГО НЕ
    // ПОКАЗЫВАЕТ ни в ▶, ни в ✔. Иначе оператор видит, что у
    // оверлока «висит 12», хотя физически эти 12 уже у киперки.
    //
    // Порядок резолва бакета на step (приоритет ▶ над ✔ — см.
    // блок `route-WIP до scan` в ТЗ §3):
    //   1) `resolved === step.operationId` → ▶ (паспорт активно
    //      работается на этой операции; перебивает любой ✔);
    //   2) иначе если `currentEmployeeId === null`,
    //      `currentRouteStepIndex === step.index` и
    //      `status === IN_PROGRESS` → ✔ (буфер «готово, ждёт
    //      следующего шага»);
    //   3) иначе паспорт на этом шаге не отображается.
    //
    // CANCELLED/PACKED-паспорта явно отсекаются: первый — снят, у
    // второго sewing-цикл уже закрыт. Это синхронно с матрицей,
    // которая их тоже игнорирует.
    //
    // Аккумулируем именно `qtyCut` (штуки), а не `+= 1` по числу
    // паспортов: на TV оператор смотрит на физический объём (один
    // паспорт = партия из N изделий). Это согласуется с матрицей
    // `/shopfloor/display`, где все остальные бакеты тоже считаются
    // в штуках.
    const sewingRouteInput = passports.map((p) => ({
      orderId: p.orderId,
      sizeId: p.sizeId,
      status: p.status,
      currentRouteStepIndex: p.currentRouteStepIndex,
      qtyCut: p.qtyCut,
      currentOperationCategory: p.currentOperation?.category ?? null,
      currentOperationId: p.currentOperation?.id ?? null,
      currentEmployeeId: p.currentEmployeeId,
      assignedShiftSewingOperationId: p.currentEmployeeId
        ? sewingShiftByEmployee.get(p.currentEmployeeId)?.id ?? null
        : null,
    }));
    const sewingRoute = buildSewingRoute(
      sewingRouteInput,
      routeSteps,
      sizes,
      orderItemSizes,
    );

    // `equipment` уже посчитан в общем `Promise.all` выше — никаких
    // дополнительных DB round-trip'ов на этом этапе.
    return {
      updatedAt: new Date().toISOString(),
      kpi,
      colors,
      totals,
      sewingColumns,
      equipment,
      sewingRoute,
      orphanMasterCalls,
    };
  }

  // -------------------------------------------------------------------------
  // DISPLAY DIVISION RESOLUTION
  // -------------------------------------------------------------------------

  /**
   * Возвращает строку-код подразделения для фильтра
   * `getDisplaySummary`, либо `null` — «не фильтровать»
   * (см. `docs/domain.md §«Подразделения заказа»`,
   * `docs/display-board.md`).
   *
   * Приоритеты (см. док-комментарий вызывающего):
   *   1) `query.divisionCode` — параметр URL, любое значение
   *      `CompanyDivision.code`;
   *   2) `user.role = DISPLAY` → ищем `DisplayScreenConfig` по
   *      `employeeId` и берём `companyDivision.code`. Конфиг с
   *      `isActive = false` или без привязанного `companyDivisionId`
   *      сознательно игнорируем — мягкий выключатель экрана даёт
   *      «общий» агрегат без удаления записи;
   *   3) иначе — `null`.
   *
   * Запрос в БД делаем только в случае (2): для не-DISPLAY-ролей и
   * для запросов с явным фильтром лишний round-trip не нужен. Это
   * держит latency polling-а большого монитора прежним.
   */
  private async resolveDisplayDivisionCode(
    query: ShopfloorDisplayQuery,
    user: AuthPrincipal | undefined,
  ): Promise<string | null> {
    if (query.divisionCode) return query.divisionCode;
    if (!user || user.role !== Role.DISPLAY) return null;
    const config = await this.prisma.displayScreenConfig.findUnique({
      where: { employeeId: user.employeeId },
      select: {
        isActive: true,
        companyDivision: { select: { code: true } },
      },
    });
    if (!config || !config.isActive) return null;
    return config.companyDivision?.code ?? null;
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
 * Собирает Prisma-фильтр `Order` по строке-коду подразделения
 * `CompanyDivision.code` (см. `docs/domain.md §«Подразделения заказа»`,
 * `docs/display-board.md`). Источник истины — FK
 * `Order.companyDivisionId → CompanyDivision`.
 */
function buildOrderDivisionFilter(
  divisionCode: string,
): Prisma.OrderWhereInput {
  return { companyDivision: { code: divisionCode } };
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

/**
 * «Какая sewing-операция сейчас ФИЗИЧЕСКИ у этого паспорта» — то,
 * что должна показать колонка ▶ split-таблицы.
 *
 * Жёсткие гварды (без них ▶ становится фантомным):
 *   - `status === IN_PROGRESS` — CREATED ещё ждёт в кройке, PACKED
 *     уже за пределами sewing-цикла, CANCELLED снят;
 *   - `currentEmployeeId !== null` — после
 *     `completeOperationByEmployee` исполнитель снимается, паспорт
 *     лежит «в корзине между шагами» и в ▶ показываться не должен
 *     (это бакет ✔, см. `buildSewingRoute`).
 *
 * Приоритет источников (важно — не как в матрице!):
 *   1) `assignedShiftSewingOperationId` — операция активной смены
 *      закреплённой швеи. Это физически точный источник: после
 *      `issueToEmployee` (даже без OPERATION_SCAN) и в момент,
 *      когда следующий sewing-step берёт паспорт, ещё хранящий
 *      `currentOperationId` от предыдущего шага, — паспорт уже на
 *      станке этой швеи. См. ТЗ §3 «не сломать route-WIP до scan»
 *      и пример «Киперка взяла → Оверлок ✔=0, Киперка ▶=12»;
 *   2) `currentOperation` категории `SEWING` — fallback, когда у
 *      сотрудника нет открытой sewing-смены (типично для seed/тестов
 *      и для редких ситуаций, где смена закрыта, а паспорт всё ещё
 *      числится за исполнителем);
 *   3) иначе — `null` (на sewing-операции паспорт «не сидит»).
 *
 * Расходимость с матричным `sewingColumnKeyOf` намеренна и
 * ограничена: матрица — это «куда отнести WIP в сетке колонок»,
 * там нет понятия employee и приоритет — это последний явный
 * `OPERATION_SCAN`. ▶ split-таблицы — это «где паспорт ФИЗИЧЕСКИ
 * сейчас», и швея на станке важнее устаревшего `currentOperationId`.
 */
function resolveCurrentSewingOperationId(p: {
  status: PassportStatus;
  currentEmployeeId: string | null;
  currentOperationCategory: OperationCategory | null;
  currentOperationId: string | null;
  assignedShiftSewingOperationId: string | null;
}): string | null {
  if (p.status !== PassportStatus.IN_PROGRESS) return null;
  if (p.currentEmployeeId === null) return null;
  if (p.assignedShiftSewingOperationId) {
    return p.assignedShiftSewingOperationId;
  }
  if (
    p.currentOperationCategory === OperationCategory.SEWING &&
    p.currentOperationId
  ) {
    return p.currentOperationId;
  }
  return null;
}

/**
 * Чистая агрегация `sewingRoute` для `/api/shopfloor/display`.
 *
 * Вынесена в отдельную функцию (не метод сервиса), чтобы легко
 * unit-тестироваться и не зависеть от Prisma. Все входы — уже
 * подготовленные плоские структуры из `getDisplaySummary`.
 *
 * Контракт (семантика «весь маршрут активных заказов + накопление WIP»):
 *
 *   1. ИСТОЧНИК ОПЕРАЦИЙ — `OrderRouteStep` snapshot активных заказов
 *      (`routeSteps` уже отфильтрованы по `operation.category = SEWING`,
 *      см. вызов `prisma.orderRouteStep.findMany` выше). Каждая
 *      уникальная sewing-операция, упомянутая в маршруте хотя бы
 *      одного активного заказа, получает СВОЙ блок — даже если по
 *      ней сейчас нет ни одного паспорта в работе/буфере.
 *
 *      Зачем: bottleneck-эвристка на UI подсвечивает СЛЕДУЮЩУЮ
 *      операцию (`processSplits[i + 1]`). Если перед пустой Киперкой
 *      на Оверлоке накопился ✔=32 — оператор должен УВИДЕТЬ Киперку
 *      (пусть и 0/0), иначе подсвечивать нечего и сигнал теряется.
 *      См. `docs/screens.md §9a.4` и `detectBottlenecks` во фронте.
 *
 *   2. SIZE-СТРОКИ блока — union размеров активных паспортов всех
 *      заказов, у которых эта операция есть в snapshot маршрута.
 *      «Активный паспорт» — не CANCELLED и не PACKED (sewing-цикл
 *      закрыт). Если у заказа ни одного активного паспорта — его
 *      размеры в union не уходят (на дисплее на эту операцию для
 *      него ничего показывать незачем).
 *
 *      Если в union пусто — блок всё равно остаётся (rows=[]); UI
 *      рисует столбец операции с ▶/✔ по grand-total = 0. Так
 *      операция остаётся видимой на матрице ради bottleneck-
 *      подсветки даже на старте смены, когда ни одного паспорта
 *      ещё не выдали.
 *
 *   3. ЗАПОЛНЕНИЕ КОЛИЧЕСТВ (▶/✔) — вторым проходом по паспортам,
 *      без изменения старой WIP-buffer семантики:
 *
 *      - CANCELLED- и PACKED-паспорта игнорируются (sewing-цикл закрыт);
 *      - паспорт игнорируется, если у него нет ни фактической sewing-
 *        операции (`resolveCurrentSewingOperationId`), ни «осевшего»
 *        `currentRouteStepIndex` на одном из sewing-шагов своего заказа;
 *      - порядок резолва бакета на step (▶ имеет приоритет над ✔):
 *          a. `resolved === step.operationId` → `inProgress`
 *             (паспорт сейчас физически в работе на этом step'е);
 *          b. иначе если паспорт без исполнителя
 *             (`currentEmployeeId === null`), `status === IN_PROGRESS`
 *             и `currentRouteStepIndex === step.index` → `done`
 *             (буфер «готово, ждёт следующего шага»). Если паспорт
 *             уже двинулся дальше (`currentRouteStepIndex > step.index`)
 *             — старый step его БОЛЬШЕ НЕ ПОКАЗЫВАЕТ;
 *          c. иначе на этом step'е паспорт не отображается.
 *
 *   4. На паспорт ровно один step попадает в ровно один бакет (или
 *      ни в один) — двойной учёт исключён.
 *
 *   5. Дедупликация: одна и та же `operationId`, упомянутая в маршрутах
 *      нескольких активных заказов, даёт ровно ОДИН блок; rows —
 *      union размеров, ▶/✔ — Σ по всем заказам.
 *
 * Сортировка стабильна между polling-tick'ами: блоки — по
 * `Operation.sortOrder`, строки — по `Size.sortOrder`. Это даёт
 * предсказуемый layout на TV (взгляд оператора не «прыгает»).
 */
function buildSewingRoute(
  passports: Array<{
    orderId: string;
    sizeId: string;
    status: PassportStatus;
    currentRouteStepIndex: number | null;
    /**
     * Количество штук в паспорте — то, что прибавляется в
     * `inProgress`/`done`. См. блок-комментарий выше про
     * семантику бакетов в штуках.
     */
    qtyCut: number;
    /**
     * Поля для резолва фактической sewing-операции через тот же
     * fallback, что использует матрица (см.
     * `resolveCurrentSewingOperationId` и `sewingColumnKeyOf`).
     * Все четыре поля могут быть `null`/`undefined` — тогда
     * сработает legacy fallback по `currentRouteStepIndex`.
     */
    currentOperationCategory: OperationCategory | null;
    currentOperationId: string | null;
    currentEmployeeId: string | null;
    assignedShiftSewingOperationId: string | null;
  }>,
  routeSteps: Array<{
    orderId: string;
    index: number;
    operation: { id: string; name: string; sortOrder: number };
  }>,
  sizes: Array<{ id: string; code: string; sortOrder: number }>,
  /**
   * Fallback `Map<orderId, Set<sizeId>>` — размеры из `OrderItem`
   * соответствующего заказа. Используется в Pass 1b, когда у заказа
   * нет ни одного «живого» паспорта (CANCELLED/PACKED-only либо
   * паспорта ещё не выпущены). Без этого fallback'а блок операции
   * получал бы `rows = []` и оператор переставал понимать, под какие
   * размеры ждать загрузку — а это и есть симптом «операция исчезла
   * с матрицы». Передаётся всегда (вызывающий — `getDisplaySummary` —
   * собирает Map по тем же активным заказам, что фильтруют
   * `routeSteps`).
   */
  orderItemSizes: Map<string, Set<string>>,
): ShopfloorDisplayRouteOperationDto[] {
  if (routeSteps.length === 0) return [];

  // Группируем sewing-шаги по `orderId`, чтобы в горячем цикле по
  // паспортам не итерироваться лишний раз по чужим заказам.
  const stepsByOrder = new Map<string, typeof routeSteps>();
  for (const step of routeSteps) {
    let arr = stepsByOrder.get(step.orderId);
    if (!arr) {
      arr = [];
      stepsByOrder.set(step.orderId, arr);
    }
    arr.push(step);
  }

  const sizeById = new Map<string, { code: string; sortOrder: number }>();
  for (const s of sizes) sizeById.set(s.id, { code: s.code, sortOrder: s.sortOrder });

  // ----- Pass 1. Реестр операций маршрута и size-union на каждую -----
  //
  // На вход уже пришли только sewing-шаги активных заказов. Мы
  // дедуплицируем их по `operationId` — одна и та же sewing-операция,
  // встретившаяся в двух заказах, должна дать ровно один блок (rows
  // — union размеров обоих заказов).
  type OpMeta = {
    name: string;
    sortOrder: number;
    /** orderIds, у которых эта операция есть в snapshot маршрута. */
    orderIds: Set<string>;
  };
  const opMeta = new Map<string, OpMeta>();
  for (const step of routeSteps) {
    let m = opMeta.get(step.operation.id);
    if (!m) {
      m = {
        name: step.operation.name,
        sortOrder: step.operation.sortOrder,
        orderIds: new Set(),
      };
      opMeta.set(step.operation.id, m);
    }
    m.orderIds.add(step.orderId);
  }

  // Активные размеры по заказу = union sizeId всех паспортов заказа,
  // которые ещё «живут» в sewing-цикле (не CANCELLED, не PACKED).
  // CREATED/IN_PROGRESS включаются — это и есть «у заказа есть
  // размер M в работе или ещё в кройке» по понятию ТЗ.
  const sizesByOrder = new Map<string, Set<string>>();
  for (const p of passports) {
    if (p.status === PassportStatus.CANCELLED) continue;
    if (p.status === PassportStatus.PACKED) continue;
    let bucket = sizesByOrder.get(p.orderId);
    if (!bucket) {
      bucket = new Set();
      sizesByOrder.set(p.orderId, bucket);
    }
    bucket.add(p.sizeId);
  }

  // ----- Pass 1b. Pre-init `(operationId, sizeId)` ячейки = 0/0 -----
  //
  // Каждая операция получает ячейки для union размеров из заказов,
  // в маршрутах которых она встречается. Это и обеспечивает «строки
  // 0/0» для пустой следующей операции: rows есть, ▶ = ✔ = 0, и UI
  // рисует видимый столбец, который bottleneck-эвристика может
  // подсветить.
  type Cell = {
    operationId: string;
    operationName: string;
    operationSortOrder: number;
    sizeId: string;
    inProgress: number;
    done: number;
  };
  const cells = new Map<string, Cell>();
  const cellKey = (operationId: string, sizeId: string): string =>
    `${operationId}|${sizeId}`;

  for (const [operationId, meta] of opMeta) {
    for (const orderId of meta.orderIds) {
      // Fallback caskade: сначала размеры живых паспортов (CREATED/
      // IN_PROGRESS), потом — размеры из `OrderItem` заказа. Второй
      // путь критичен для инварианта «операция активного заказа не
      // может исчезнуть»: если все паспорта заказа PACKED/CANCELLED
      // (или ещё не выпущены), `sizesByOrder` для него пуст, но
      // блок всё равно должен показать строки 0/0 для размеров,
      // под которые заказ был оформлен. Иначе оператор увидит
      // «пустой» блок без rows — на TV это визуально неотличимо от
      // «операция пропала» (см. ROOT CAUSE в шапке `buildSewingRoute`).
      let sizeIds = sizesByOrder.get(orderId);
      if (!sizeIds || sizeIds.size === 0) {
        sizeIds = orderItemSizes.get(orderId);
      }
      if (!sizeIds || sizeIds.size === 0) continue;
      for (const sizeId of sizeIds) {
        const key = cellKey(operationId, sizeId);
        if (cells.has(key)) continue;
        cells.set(key, {
          operationId,
          operationName: meta.name,
          operationSortOrder: meta.sortOrder,
          sizeId,
          inProgress: 0,
          done: 0,
        });
      }
    }
  }

  // ----- Pass 2. Заполняем фактические ▶/✔ по живым паспортам -----
  for (const p of passports) {
    // Sewing-цикл закрыт у обоих этих статусов: CANCELLED — снят,
    // PACKED — уже за пределами sewing'а. Их учёт в ▶/✔ был бы
    // фантомным.
    if (p.status === PassportStatus.CANCELLED) continue;
    if (p.status === PassportStatus.PACKED) continue;
    const steps = stepsByOrder.get(p.orderId);
    if (!steps) continue;
    const idx = p.currentRouteStepIndex;
    const resolved = resolveCurrentSewingOperationId(p);
    // Если паспорт ничем не привязан ни к sewing-step'у маршрута,
    // ни к фактической sewing-операции — он не даёт ▶/✔; но 0/0
    // строки для его размера у соответствующих операций уже созданы
    // в Pass 1b.
    if (idx === null && resolved === null) continue;

    for (const step of steps) {
      let bucket: 'inProgress' | 'done' | null = null;
      if (resolved === step.operation.id) {
        // ▶ имеет приоритет над ✔: даже если на каком-то шаге
        // паспорт «стоит ровно на step.index» по индексу, но
        // фактически уже взят следующей швеёй (assigned shift
        // указывает на её операцию) — он показывается у НЕЁ в ▶,
        // а старая операция не получает ✔.
        bucket = 'inProgress';
      } else if (
        p.currentEmployeeId === null &&
        p.status === PassportStatus.IN_PROGRESS &&
        idx !== null &&
        idx === step.index
      ) {
        // ✔ = буфер между текущим и следующим step'ом: операция
        // завершена (исполнитель снят `completeOperationByEmployee`),
        // но `currentRouteStepIndex` ещё не двинулся (двигается
        // только при `OPERATION_SCAN` следующего шага). Как только
        // следующий step делает scan, idx увеличится — и этот ✔
        // автоматически очистится (старый step перестанет проходить
        // условие `idx === step.index`).
        bucket = 'done';
      } else {
        continue;
      }
      const key = cellKey(step.operation.id, p.sizeId);
      let cell = cells.get(key);
      if (!cell) {
        // Defensive: размер паспорта не попал в Pass 1b (например,
        // CREATED-паспорт без `currentRouteStepIndex` уже учтён в
        // sizesByOrder, но если по какой-то причине нет — добавляем
        // ячейку прямо здесь, чтобы не потерять ▶/✔).
        cell = {
          operationId: step.operation.id,
          operationName: step.operation.name,
          operationSortOrder: step.operation.sortOrder,
          sizeId: p.sizeId,
          inProgress: 0,
          done: 0,
        };
        cells.set(key, cell);
      }
      // Прибавляем штуки (qtyCut), а не +1 за паспорт. Один паспорт
      // — это «партия из N изделий» одного размера/цвета; на дисплее
      // оператор хочет видеть именно сколько ШТУК сейчас на каждом
      // шаге, а не сколько паспортов.
      cell[bucket] += p.qtyCut;
    }
  }

  // ----- Сборка блоков по operationId -----
  type Block = {
    operationId: string;
    operationName: string;
    operationSortOrder: number;
    rows: ShopfloorDisplayRouteSizeRowDto[];
  };
  const blocks = new Map<string, Block>();
  // Сначала пересоздаём блоки для ВСЕХ операций маршрута (даже без
  // ячеек) — это и есть «весь маршрут активных заказов виден».
  for (const [operationId, meta] of opMeta) {
    blocks.set(operationId, {
      operationId,
      operationName: meta.name,
      operationSortOrder: meta.sortOrder,
      rows: [],
    });
  }
  for (const cell of cells.values()) {
    const block = blocks.get(cell.operationId);
    // Block гарантированно существует — мы его создали из opMeta выше.
    if (!block) continue;
    const meta = sizeById.get(cell.sizeId);
    block.rows.push({
      size: meta?.code ?? '—',
      sizeSortOrder: meta?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      inProgress: cell.inProgress,
      done: cell.done,
    });
  }

  const result = Array.from(blocks.values())
    .map((b) => ({
      operationId: b.operationId,
      operationName: b.operationName,
      operationSortOrder: b.operationSortOrder,
      rows: b.rows
        .slice()
        .sort((a, b2) => a.sizeSortOrder - b2.sizeSortOrder),
    }))
    .sort((a, b) => a.operationSortOrder - b.operationSortOrder);

  // Defensive invariant log: каждая sewing-операция, встретившаяся
  // в snapshot маршрута активного заказа, ОБЯЗАНА присутствовать в
  // результате (даже с rows=[] или rows из 0/0 fallback'а). Если
  // когда-нибудь регресс «операция исчезла» вернётся (новый skip,
  // фильтр по totals, и т. п.) — он сразу всплывёт в логе API, и
  // его не придётся дебажить через UI монитора цеха.
  const presentIds = new Set(result.map((b) => b.operationId));
  for (const step of routeSteps) {
    if (!presentIds.has(step.operation.id)) {
      // eslint-disable-next-line no-console
      console.warn('DISPLAY: missing operation in sewingRoute', {
        orderId: step.orderId,
        operationId: step.operation.id,
        operationName: step.operation.name,
      });
    }
  }

  return result;
}
