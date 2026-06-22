import { Injectable } from '@nestjs/common';
import {
  OperationCategory,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import {
  PRODUCTION_BOARD_RELEASED,
  type ProductionBoardCohortDto,
  type ProductionBoardDrillDto,
  type ProductionBoardDrillEmployeeGroupDto,
  type ProductionBoardDrillQuery,
  type ProductionBoardDto,
  type ProductionBoardEmployeeDto,
  type ProductionBoardPassportRowDto,
  type ProductionBoardQuery,
  type ProductionBoardStageBucketDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * «Доска движения тиража» для кабинета мастера.
 *
 * Модель — когорта по дате выдачи кроя (`Passport.cutDate`, UTC-день).
 *
 * Колонки доски — НЕ статический список. Они вычисляются из
 * `OrderRouteStep` snapshot'ов заказов, чьи паспорта попали в окно
 * когорты: каждая уникальная операция маршрута (sewing + ОТК/ВТО/
 * упаковка, без кройки) → одна колонка, порядок — `Operation.sortOrder`.
 * Это тот же источник операций, что у «Экрана цеха»
 * (`ShopfloorService.buildSewingRoute`): сколько оверлоков реально в
 * маршруте — столько и колонок, без фантомных.
 *
 * Раскладка паспорта по колонке — через тот же резолвер текущей
 * операции, что использует display (`resolveColumnOp` ниже, зеркало
 * `resolveCurrentSewingOperationId` из `ShopfloorService`): паспорт,
 * выданный швее, но ещё не отсканированный на операцию (его
 * `currentOperation` всё ещё CUT_DIVISION, а реальная операция — в её
 * открытой `ShiftSession`), попадает в правильную колонку, а не
 * теряется.
 *
 * Штуки: «выдано» / «в работе» / ячейки операций — `qtyCut`
 * (физический объём кроя, как на «Экране цеха»); «выпущено» —
 * `qtyGood` (за вычетом брака, как KPI display). Брак — `qtyDefect`.
 *
 * Read-only: сервис только агрегирует, ничего не мутирует. Контракт —
 * `@sewing/shared` (`packages/shared/src/production-board.ts`).
 */
@Injectable()
export class ProductionBoardService {
  constructor(private readonly prisma: PrismaService) {}

  /** UTC-`YYYY-MM-DD` из Date. */
  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** [from, to] окно: последние `days` дней включая сегодня (UTC).
   * Применяется к ДАТЕ ВЫДАЧИ кроя (`ISSUED_TO_EMPLOYEE.createdAt`). */
  private window(days: number): { from: Date; to: Date } {
    const now = new Date();
    const to = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    from.setUTCHours(0, 0, 0, 0);
    return { from, to };
  }

  /**
   * Резолвер колонки паспорта — повторяет ОБЕ механики «Экрана цеха»
   * (`ShopfloorService.buildSewingRoute`), а не только активную:
   *
   *  1. АКТИВНО (▶, есть исполнитель). Зеркало
   *     `resolveCurrentSewingOperationId`: приоритет открытой
   *     sewing-смены над `currentOperation` — после `issueToEmployee`
   *     `Passport.currentOperationId` ещё указывает на CUT_DIVISION, а
   *     доменно правильная операция швеи лежит в её активной
   *     `ShiftSession.operationId`. Для ОТК/ВТО/упаковки sewing-смены
   *     нет → берём `currentOperation` (он уже корректен). Если же
   *     открытой смены нет, а `currentOperation` ещё кроечный (выдан, но
   *     не отсканирован) — кладём паспорт на ПЕРВУЮ швейную операцию
   *     маршрута заказа, иначе он пропадёт с доски, когда швея закроет
   *     смену (положение «issued-but-not-scanned» жило только в смене).
   *
   *  2. БУФЕР (✔, `currentEmployeeId = null`). Швея сдала операцию,
   *     паспорт ждёт следующего шага. Display в этом случае ставит ✔
   *     на шаг с `index === currentRouteStepIndex` — НЕ на устаревший
   *     `currentOperation`. Повторяем: позиция = операция РЕАЛЬНОГО
   *     шага маршрута заказа по `currentRouteStepIndex`. Без этого
   *     доска и display расходятся, как только `currentRouteStepIndex`
   *     уехал вперёд, а `currentOperation` остался на прошлой операции.
   *
   * `null` — паспорт не на одной из колонок доски (ещё в кройке,
   * маршрут заказа не зафиксирован, или статус ≠ IN_PROGRESS).
   */
  private resolveColumnOp(
    p: {
      status: PassportStatus;
      orderId: string | null;
      currentEmployeeId: string | null;
      currentRouteStepIndex: number | null;
      currentOperation: { id: string; code: string } | null;
    },
    sewingShiftByEmployee: Map<string, { id: string; code: string }>,
    opByOrderIndex: Map<string, Map<number, { id: string; code: string }>>,
  ): { id: string; code: string } | null {
    if (p.status !== PassportStatus.IN_PROGRESS) return null;

    // Не-кроечные шаги маршрута ЭТОГО заказа (`opByOrderIndex` уже без
    // кройки). Из них — два хелпера для fallback'а «выдан швее, но
    // операция в паспорте ещё кроечная»:
    //   isColumnOp   — операция реально присутствует как колонка маршрута;
    //   firstSewingOp — первая (минимальный index) швейная операция.
    const byOrder = p.orderId ? opByOrderIndex.get(p.orderId) : undefined;
    const isColumnOp = (id: string): boolean => {
      if (!byOrder) return false;
      for (const o of byOrder.values()) if (o.id === id) return true;
      return false;
    };
    const firstSewingOp = (): { id: string; code: string } | null => {
      if (!byOrder) return null;
      let minIdx = Infinity;
      let op: { id: string; code: string } | null = null;
      for (const [idx, o] of byOrder) {
        if (idx < minIdx) {
          minIdx = idx;
          op = o;
        }
      }
      return op;
    };

    if (p.currentEmployeeId !== null) {
      const shiftOp = sewingShiftByEmployee.get(p.currentEmployeeId);
      if (shiftOp) return shiftOp;
      // Открытой швейной смены нет. `currentOperation` может быть
      // устаревшей кроечной операцией: паспорт выдан швее, но первый
      // `OPERATION_SCAN` на швейную операцию не прошёл, а маршрут не
      // сдвинулся с кройки (см. project_no_operation_scan_events). Если
      // currentOperation — реальная колонка маршрута заказа (швея уже на
      // ОТК/ВТО/упаковке либо была отсканирована), берём её. Иначе кладём
      // паспорт на первую швейную операцию маршрута, чтобы выданный-но-
      // не-начатый паспорт не исчезал с доски, как только швея закроет
      // смену (без этого 114 шт «в работе» пропадали, 21.05.2026).
      if (p.currentOperation && isColumnOp(p.currentOperation.id))
        return p.currentOperation;
      return firstSewingOp();
    }
    // Буфер: «закончил операцию, ждёт следующего шага» — позиция по
    // реальному шагу маршрута (как ✔ done на «Экране цеха»).
    if (p.currentRouteStepIndex === null || !p.orderId) return null;
    return byOrder?.get(p.currentRouteStepIndex) ?? null;
  }

  async getBoard(query: ProductionBoardQuery): Promise<ProductionBoardDto> {
    const { from, to } = this.window(query.days);

    // Когорта — по ДАТЕ ВЫДАЧИ кроя швеям (`ISSUED_TO_EMPLOYEE`), НЕ по
    // `Passport.cutDate`. День строки паспорта = UTC-день его АБСОЛЮТНО
    // ПЕРВОЙ выдачи (когда тираж впервые ушёл в пошив), а НЕ первой
    // выдачи «в пределах окна». Окно лишь решает, какие строки показать.
    //
    // Почему абсолютная, а не оконная: паспорт по ходу маршрута выдают
    // несколько раз (каждый следующий работник «берёт крой» → новый
    // `ISSUED`). При оконной привязке расширение окна 7→14 втягивало
    // раннюю перевыдачу, и паспорт «переезжал» в более раннюю строку —
    // один и тот же день показывал РАЗНЫЕ числа на 7/14/30 (инцидент
    // 22.05.2026: ОВР строки 20.05, 7д≠14д на 11 паспортов). Абсолютная
    // дата стабильна. Цена: партия, впервые выданная ДО начала окна, в
    // коротком окне не показывается (её настоящая строка вне окна).
    //
    // Кандидаты — паспорта с хотя бы одной выдачей в окне; для них
    // считаем абсолютно первую выдачу по ВСЕЙ истории, затем отбрасываем
    // тех, чья первая выдача раньше окна.
    const inWindowIssues = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.ISSUED_TO_EMPLOYEE,
        createdAt: { gte: from, lte: to },
      },
      select: { passportId: true },
    });
    const candidateIds = [
      ...new Set(inWindowIssues.map((e) => e.passportId)),
    ];
    const issueDateByPassport = new Map<string, Date>();
    if (candidateIds.length > 0) {
      const allIssues = await this.prisma.passportEvent.findMany({
        where: {
          type: PassportEventType.ISSUED_TO_EMPLOYEE,
          passportId: { in: candidateIds },
        },
        select: { passportId: true, createdAt: true },
      });
      for (const e of allIssues) {
        const cur = issueDateByPassport.get(e.passportId);
        if (!cur || e.createdAt < cur)
          issueDateByPassport.set(e.passportId, e.createdAt);
      }
      // Первая выдача раньше окна → стабильная строка вне окна, не показываем.
      for (const [pid, d] of issueDateByPassport) {
        if (d < from) issueDateByPassport.delete(pid);
      }
    }
    const passportIds = [...issueDateByPassport.keys()];

    const passports =
      passportIds.length > 0
        ? await this.prisma.passport.findMany({
            where: { id: { in: passportIds } },
            select: {
              id: true,
              qtyCut: true,
              qtyGood: true,
              qtyDefect: true,
              status: true,
              // Soft-route индекс — для «не дошло» по РЕАЛЬНОМУ
              // порядку `OrderRouteStep` его заказа.
              currentRouteStepIndex: true,
              currentEmployeeId: true,
              currentOperation: { select: { id: true, code: true } },
              currentEmployee: { select: { id: true, fullName: true } },
              orderId: true,
              order: { select: { number: true, customer: true } },
            },
          })
        : [];

    const orderIds = [
      ...new Set(passports.map((p) => p.orderId).filter((x): x is string => !!x)),
    ];

    // Открытые sewing-смены — fallback-источник операции для паспортов,
    // выданных швее, но ещё не отсканированных (см. `resolveColumnOp`).
    // Узкий фильтр (endedAt=null + category SEWING) держит выборку
    // маленькой. Тот же запрос, что в `ShopfloorService.getDisplaySummary`.
    const sewingShiftByEmployee = new Map<
      string,
      { id: string; code: string }
    >();
    {
      const shifts = await this.prisma.shiftSession.findMany({
        where: {
          endedAt: null,
          operation: { category: OperationCategory.SEWING },
        },
        select: {
          employeeId: true,
          operation: { select: { id: true, code: true } },
        },
      });
      for (const s of shifts) {
        sewingShiftByEmployee.set(s.employeeId, {
          id: s.operation.id,
          code: s.operation.code,
        });
      }
    }

    // Снимки маршрутов заказов когорты — ИСТОЧНИК КОЛОНОК (тот же, что
    // у «Экрана цеха»). Без кройки: доска ведёт партию от выдачи кроя
    // через пошив → ОТК → ВТО → упаковку. Уникальная операция → колонка,
    // порядок — `Operation.sortOrder`.
    const routeSteps =
      orderIds.length > 0
        ? await this.prisma.orderRouteStep.findMany({
            where: {
              orderId: { in: orderIds },
              operation: {
                category: { not: OperationCategory.CUTTING },
              },
            },
            select: {
              orderId: true,
              index: true,
              operation: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  sortOrder: true,
                },
              },
            },
          })
        : [];

    // Реестр колонок (дедуп по operationId) + два индекса по заказу:
    //   opIndexByOrder  — operationId → шаг (для «не дошло»);
    //   opByOrderIndex  — шаг → {id,code} (для ✔-буфера в resolveColumnOp).
    interface ColMeta {
      code: string;
      label: string;
      sortOrder: number;
    }
    const columns = new Map<string, ColMeta>();
    const opIndexByOrder = new Map<string, Map<string, number>>();
    const opByOrderIndex = new Map<
      string,
      Map<number, { id: string; code: string }>
    >();
    for (const st of routeSteps) {
      if (!columns.has(st.operation.id)) {
        columns.set(st.operation.id, {
          code: st.operation.code,
          label: st.operation.name,
          sortOrder: st.operation.sortOrder,
        });
      }
      let m = opIndexByOrder.get(st.orderId);
      if (!m) {
        m = new Map();
        opIndexByOrder.set(st.orderId, m);
      }
      m.set(st.operation.id, st.index);
      let bi = opByOrderIndex.get(st.orderId);
      if (!bi) {
        bi = new Map();
        opByOrderIndex.set(st.orderId, bi);
      }
      bi.set(st.index, { id: st.operation.id, code: st.operation.code });
    }
    const orderedCols = [...columns.entries()]
      .map(([id, meta]) => ({ id, ...meta }))
      .sort((a, b) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : a.code < b.code
            ? -1
            : 1,
      );

    // «Выдан» = паспорт в выборке. «В работе» = паспорт реально начат
    // или завершён, ЛИБО прямо сейчас закреплён за швеёй
    // (`currentEmployeeId != null AND status = IN_PROGRESS`).
    //
    // Раньше критерий был «есть ≥1 из [OPERATION_SCAN, OPERATION_STARTED,
    // OPERATION_FINISHED]», но реальный флоу не пишет ни SCAN, ни
    // STARTED (см. `project_no_operation_scan_events`); между
    // `ISSUED_TO_EMPLOYEE` и `OPERATION_FINISHED` НИ ОДНОГО из этих
    // событий нет. Из-за этого 25 паспортов, которые Акмарал прямо
    // сейчас шьёт на ОВР, ложно попадали в чип «не взято» когорты
    // (21.05.2026). Добавили `currentEmployeeId != null` — теперь
    // «не взято» означает строго «выдано, но никто не работает и
    // никто не завершал».
    const inOpsSet = new Set<string>();
    // `finishedOpsByPassport` — operationId, на которых для паспорта
    // есть `OPERATION_FINISHED`.
    const finishedOpsByPassport = new Map<string, Set<string>>();
    // `finisherByPassportOp` — кто закрыл операцию X на паспорте
    // (последний `OPERATION_FINISHED.employeeId` для (passportId,
    // operationId)). Нужно для атрибуции «буферных» паспортов
    // (`currentEmployeeId = null` после complete) реальному финишёру —
    // вместо анонимной группы «В буфере» рисуем «✔ <фамилия>».
    const finisherByPassportOp = new Map<
      string,
      { id: string; fullName: string }
    >();
    if (passports.length > 0) {
      const passIds = passports.map((p) => p.id);
      const [inOpsRows, finishedRows] = await Promise.all([
        this.prisma.passportEvent.groupBy({
          by: ['passportId'],
          where: {
            passportId: { in: passIds },
            type: {
              in: [
                PassportEventType.OPERATION_SCAN,
                PassportEventType.OPERATION_STARTED,
                PassportEventType.OPERATION_FINISHED,
              ],
            },
          },
          _count: { _all: true },
        }),
        this.prisma.passportEvent.findMany({
          where: {
            passportId: { in: passIds },
            // «Терминал на операции» = пошив закрылся через
            // `OPERATION_FINISHED`, ОТК — через `QC_PASSED`, ВТО —
            // через `WTO_PASSED`, упаковка — через `PACKED`. Все
            // четыре события несут `operationId` шага и `employeeId`
            // исполнителя, поэтому колонка доски считает их одинаково
            // («дошло» / «выпущено» + атрибуция финишёру). До этого
            // ОТК/ВТО/УПАКОВКА на доске всегда были пустыми, потому
            // что считали только `OPERATION_FINISHED`.
            type: {
              in: [
                PassportEventType.OPERATION_FINISHED,
                PassportEventType.QC_PASSED,
                PassportEventType.WTO_PASSED,
                PassportEventType.PACKED,
              ],
            },
            operationId: { not: null },
          },
          select: {
            passportId: true,
            operationId: true,
            createdAt: true,
            employee: { select: { id: true, fullName: true } },
          },
          // По убыванию — первый в выдаче по паре (passportId,operationId)
          // станет финишёром-источником правды (`Map.set` ниже не
          // перезаписывает после первого `has`).
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      for (const row of inOpsRows) inOpsSet.add(row.passportId);
      for (const ev of finishedRows) {
        if (!ev.operationId) continue;
        let s = finishedOpsByPassport.get(ev.passportId);
        if (!s) {
          s = new Set();
          finishedOpsByPassport.set(ev.passportId, s);
        }
        s.add(ev.operationId);
        const key = `${ev.passportId}:${ev.operationId}`;
        if (ev.employee && !finisherByPassportOp.has(key)) {
          finisherByPassportOp.set(key, {
            id: ev.employee.id,
            fullName: ev.employee.fullName,
          });
        }
      }
    }
    // Доп.источник «в работе» — паспорт закреплён за сотрудником
    // прямо сейчас (см. комментарий выше).
    for (const p of passports) {
      if (
        p.currentEmployeeId !== null &&
        p.status === PassportStatus.IN_PROGRESS
      ) {
        inOpsSet.add(p.id);
      }
    }

    // Когорта = UTC-день выдачи кроя швеям (первый ISSUED_TO_EMPLOYEE).
    interface CohortPassport {
      passportId: string;
      orderId: string;
      isPacked: boolean;
      qtyCut: number;
      qtyDefect: number;
      // operationId, где сейчас находится паспорт (через резолвер).
      // `null` — не на колонке доски (например, ещё в кройке / маршрут
      // заказа не зафиксирован / PACKED).
      currentOpId: string | null;
      currentEmployeeId: string | null;
      currentEmployeeName: string;
      // Operation ids, на которых для этого паспорта есть OPERATION_FINISHED.
      finishedOpIds: Set<string>;
    }
    interface Acc {
      issueDate: string;
      orderIds: Set<string>;
      orderLabel: string;
      issuedPassports: number;
      issuedQty: number;
      inOpsPassports: number;
      inOpsQty: number;
      releasedPassports: number;
      releasedQty: number;
      // Снимок паспортов когорты — ЕДИНЫЙ источник и для накопительных
      // received/released по колонке, и для разбивки по сотрудникам
      // (плашки). Так число в ячейке и список в drill всегда совпадают:
      // оба строятся из одного множества (см. формулу в shared-DTO).
      passports: CohortPassport[];
    }

    const NO_EMP = '__none__';
    const cohorts = new Map<string, Acc>();
    const ensure = (key: string, p: (typeof passports)[number]): Acc => {
      let a = cohorts.get(key);
      if (!a) {
        a = {
          issueDate: key,
          orderIds: new Set(),
          orderLabel: '',
          issuedPassports: 0,
          issuedQty: 0,
          inOpsPassports: 0,
          inOpsQty: 0,
          releasedPassports: 0,
          releasedQty: 0,
          passports: [],
        };
        cohorts.set(key, a);
      }
      if (p.orderId) a.orderIds.add(p.orderId);
      if (p.order && a.orderLabel === '') {
        a.orderLabel =
          `#${p.order.number}` +
          (p.order.customer ? ` · ${p.order.customer}` : '');
      }
      return a;
    };

    for (const p of passports) {
      const issuedAt = issueDateByPassport.get(p.id);
      if (!issuedAt) continue; // не выдан в окне — не на доске
      const key = this.dayKey(issuedAt);
      const a = ensure(key, p);
      const isInOps = inOpsSet.has(p.id);
      const isPacked = p.status === PassportStatus.PACKED;

      // Каждый паспорт выборки выдан (есть ISSUED_TO_EMPLOYEE в окне).
      a.issuedPassports += 1;
      a.issuedQty += p.qtyCut;
      if (isInOps) {
        a.inOpsPassports += 1;
        a.inOpsQty += p.qtyCut;
      }

      const op = isPacked
        ? null
        : this.resolveColumnOp(p, sewingShiftByEmployee, opByOrderIndex);

      // Снимок паспорта когорты. Разбивка по колонкам/сотрудникам и
      // received/released строятся ниже из этого снимка — единым проходом,
      // чтобы число в ячейке и список в drill совпадали.
      a.passports.push({
        passportId: p.id,
        orderId: p.orderId ?? '',
        isPacked,
        qtyCut: p.qtyCut,
        qtyDefect: p.qtyDefect,
        currentOpId: op && columns.has(op.id) ? op.id : null,
        currentEmployeeId: p.currentEmployeeId,
        currentEmployeeName: p.currentEmployee?.fullName ?? '—',
        finishedOpIds: finishedOpsByPassport.get(p.id) ?? new Set(),
      });

      if (isPacked) {
        a.releasedPassports += 1;
        a.releasedQty += p.qtyGood;
      }
    }

    const cohortDtos: ProductionBoardCohortDto[] = [...cohorts.values()]
      .sort((x, y) => (x.issueDate < y.issueDate ? 1 : -1))
      .map((a) => {
        const stages: ProductionBoardStageBucketDto[] = orderedCols.map(
          (col) => {
            // Единый проход по снимку когорты: и накопительные
            // received/released, и разбивка по сотрудникам (плашки) — из
            // ОДНОГО множества, чтобы число в ячейке совпадало со списком
            // в drill (`getDrill` перечисляет ровно это множество).
            //   - ВЫПУЩЕНО (released:true): паспорт завершил X-или-дальше
            //     (`furthest >= idx`) либо PACKED. Атрибуция — финишёру X
            //     (`finisherByPassportOp`); если X проскочили без скана
            //     (finish только на более поздней операции) — анонимная
            //     группа «Прошло без скана».
            //   - АКТИВНО (released:false): стоит на X (резолвер) и ещё не
            //     завершил → «Сейчас K».
            const byKey = new Map<
              string,
              {
                employeeId: string | null;
                employeeName: string;
                passports: number;
                qty: number;
                defects: number;
                released: boolean;
              }
            >();
            const attribute = (
              employeeId: string | null,
              employeeName: string,
              isReleased: boolean,
              cp: CohortPassport,
            ): void => {
              const k = (employeeId ?? NO_EMP) + (isReleased ? ':r' : ':a');
              let agg = byKey.get(k);
              if (!agg) {
                agg = {
                  employeeId,
                  employeeName,
                  passports: 0,
                  qty: 0,
                  defects: 0,
                  released: isReleased,
                };
                byKey.set(k, agg);
              }
              agg.passports += 1;
              agg.qty += cp.qtyCut;
              agg.defects += cp.qtyDefect;
            };

            let received = 0;
            let released = 0;
            for (const cp of a.passports) {
              // Колонка неприменима к заказу без этой операции в маршруте.
              const colIdxInOrder = opIndexByOrder
                .get(cp.orderId)
                ?.get(col.id);
              if (colIdxInOrder === undefined) continue;

              // ПО-ОПЕРАЦИОННО (честно), без воронки: колонка отражает
              // только то, что реально было НА этой операции.
              //   выпущено(X) = есть OPERATION_FINISHED именно на X;
              //   дошло(X)    = активны на X + закрыли X.
              // Проскоченная операция (ОВР→РАСПОШИВ мимо КИПЕРКИ) даёт 0 —
              // пропуск виден, а не маскируется «прошёл дальше».
              const finishedThisOp = cp.finishedOpIds.has(col.id);
              const currentlyHere = cp.currentOpId === col.id;

              if (finishedThisOp) {
                received += 1;
                released += 1;
                const finisher = finisherByPassportOp.get(
                  `${cp.passportId}:${col.id}`,
                );
                if (finisher)
                  attribute(finisher.id, finisher.fullName, true, cp);
                else attribute(null, 'Закрыто', true, cp);
              } else if (currentlyHere && cp.currentEmployeeId) {
                // Активно работает X и ещё не закрыл.
                received += 1;
                attribute(
                  cp.currentEmployeeId,
                  cp.currentEmployeeName,
                  false,
                  cp,
                );
              }
            }

            const employees: ProductionBoardEmployeeDto[] = [
              ...byKey.values(),
            ]
              .map((e) => ({
                employeeId: e.employeeId ?? '',
                employeeName: e.employeeName,
                passports: e.passports,
                qty: e.qty,
                defects: e.defects,
                released: e.released,
              }))
              // Активная работа сверху, выпущенные ниже; внутри — по убыв.
              .sort((m, n) => {
                if (m.released !== n.released) return m.released ? 1 : -1;
                return n.passports - m.passports;
              });

            // «Сейчас K» = только активная работа (released:false).
            // Инвариант shared-DTO: passports = received − released.
            const passportsAt = employees.reduce(
              (s, e) => (e.released ? s : s + e.passports),
              0,
            );
            const qtyAt = employees.reduce(
              (s, e) => (e.released ? s : s + e.qty),
              0,
            );
            const defectsAt = employees.reduce(
              (s, e) => (e.released ? s : s + e.defects),
              0,
            );

            return {
              code: col.code,
              passports: passportsAt,
              qty: qtyAt,
              defects: defectsAt,
              employees,
              received,
              released,
            };
          },
        );

        const orderLabel =
          a.orderIds.size > 1
            ? `${a.orderIds.size} заказ(ов)`
            : a.orderLabel || '—';

        return {
          issueDate: a.issueDate,
          orderId: a.orderIds.size === 1 ? [...a.orderIds][0] : null,
          orderLabel,
          issuedPassports: a.issuedPassports,
          issuedQty: a.issuedQty,
          inOpsPassports: a.inOpsPassports,
          inOpsQty: a.inOpsQty,
          notPickedPassports: Math.max(
            0,
            a.issuedPassports - a.inOpsPassports,
          ),
          releasedPassports: a.releasedPassports,
          releasedQty: a.releasedQty,
          stages,
        };
      });

    return {
      from: this.dayKey(from),
      to: this.dayKey(to),
      stages: orderedCols.map((c) => ({ code: c.code, label: c.label })),
      cohorts: cohortDtos,
    };
  }

  /** Drill-down: список паспортов когорты на стадии (опц. по сотруднику). */
  async getDrill(
    query: ProductionBoardDrillQuery,
  ): Promise<ProductionBoardDrillDto> {
    const dayStart = new Date(`${query.issueDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${query.issueDate}T23:59:59.999Z`);
    const released = query.stage === PRODUCTION_BOARD_RELEASED;

    // Когорта дня = паспорта, чья АБСОЛЮТНО ПЕРВАЯ выдача швеям пришлась
    // на этот UTC-день. Тот же ключ, что у доски (`getBoard`): берём
    // паспорта с выдачей в этот день, затем оставляем лишь тех, у кого
    // это и есть первая выдача. Иначе перевыданный паспорт попал бы и в
    // свою раннюю строку, и в этот день — drill разошёлся бы с доской, а
    // числа дня зависели бы от окна (см. инцидент 22.05.2026).
    const issuedThatDay = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.ISSUED_TO_EMPLOYEE,
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      select: { passportId: true },
    });
    const issuedThatDayIds = [
      ...new Set(issuedThatDay.map((e) => e.passportId)),
    ];
    let dayPassportIds: string[] = [];
    if (issuedThatDayIds.length > 0) {
      const allIssues = await this.prisma.passportEvent.findMany({
        where: {
          type: PassportEventType.ISSUED_TO_EMPLOYEE,
          passportId: { in: issuedThatDayIds },
        },
        select: { passportId: true, createdAt: true },
      });
      const firstByPassport = new Map<string, Date>();
      for (const e of allIssues) {
        const cur = firstByPassport.get(e.passportId);
        if (!cur || e.createdAt < cur)
          firstByPassport.set(e.passportId, e.createdAt);
      }
      dayPassportIds = issuedThatDayIds.filter((id) => {
        const d = firstByPassport.get(id);
        return d !== undefined && d >= dayStart;
      });
    }

    if (released) {
      // «Выпущено» — статус PACKED. Резолвер не нужен.
      const packed =
        dayPassportIds.length === 0
          ? []
          : await this.prisma.passport.findMany({
        where: {
          id: { in: dayPassportIds },
          status: PassportStatus.PACKED,
        },
        select: {
          id: true,
          number: true,
          qtyGood: true,
          qtyDefect: true,
          size: { select: { code: true } },
        },
        orderBy: { number: 'asc' },
      });
      const rows: ProductionBoardPassportRowDto[] = packed.map((p) => ({
        passportId: p.id,
        number: p.number,
        sizeCode: p.size?.code ?? '—',
        qty: p.qtyGood,
        defects: p.qtyDefect,
        employeeName: null,
      }));
      const group: ProductionBoardDrillEmployeeGroupDto = {
        employeeId: null,
        employeeName: 'Выпущено (PACKED)',
        passports: rows.length,
        qty: rows.reduce((s, r) => s + r.qty, 0),
        defects: rows.reduce((s, r) => s + r.defects, 0),
        released: true,
        rows,
      };
      return {
        issueDate: query.issueDate,
        stageLabel: 'Выпущено',
        totalPassports: rows.length,
        totalQty: group.qty,
        totalDefects: group.defects,
        groups: rows.length > 0 ? [group] : [],
      };
    }

    // Для стадии-операции фильтруем тем же резолвером, что и доска
    // (нельзя в SQL: «выдан швее, но не отсканирован» и ✔-буфер
    // определяются через открытую sewing-смену / шаг маршрута).
    // Берём живые паспорта когорты дня и отбираем те, чья
    // резолв-операция == `query.stage`.
    const candidates =
      dayPassportIds.length === 0
        ? []
        : await this.prisma.passport.findMany({
      where: {
        id: { in: dayPassportIds },
        // PACKED тоже: ячейка считает упакованные в received/released
        // каждой пройденной стадии — drill должен их перечислять.
        status: { in: [PassportStatus.IN_PROGRESS, PassportStatus.PACKED] },
      },
      select: {
        id: true,
        number: true,
        qtyCut: true,
        qtyDefect: true,
        status: true,
        orderId: true,
        currentRouteStepIndex: true,
        size: { select: { code: true } },
        currentEmployeeId: true,
        currentOperation: { select: { id: true, code: true } },
        currentEmployee: { select: { fullName: true } },
      },
      orderBy: { number: 'asc' },
    });

    // Шаг маршрута → операция, по заказам кандидатов (для ✔-буфера в
    // `resolveColumnOp`). Без кройки — как в `getBoard`.
    const drillOrderIds = [
      ...new Set(
        candidates.map((p) => p.orderId).filter((x): x is string => !!x),
      ),
    ];
    const opByOrderIndex = new Map<
      string,
      Map<number, { id: string; code: string }>
    >();
    // Обратная карта `opId → index` по заказу — для furthest/colIdx
    // (как `opIndexByOrder` в getBoard).
    const opIndexByOrder = new Map<string, Map<string, number>>();
    if (drillOrderIds.length > 0) {
      const rs = await this.prisma.orderRouteStep.findMany({
        where: {
          orderId: { in: drillOrderIds },
          operation: { category: { not: OperationCategory.CUTTING } },
        },
        select: {
          orderId: true,
          index: true,
          operation: { select: { id: true, code: true } },
        },
      });
      for (const st of rs) {
        let bi = opByOrderIndex.get(st.orderId);
        if (!bi) {
          bi = new Map();
          opByOrderIndex.set(st.orderId, bi);
        }
        bi.set(st.index, { id: st.operation.id, code: st.operation.code });
        let oi = opIndexByOrder.get(st.orderId);
        if (!oi) {
          oi = new Map();
          opIndexByOrder.set(st.orderId, oi);
        }
        oi.set(st.operation.id, st.index);
      }
    }

    // finishedOpIds по кандидатам — для накопительного «дошло/выпущено»
    // (тот же снимок, что у getBoard), а не только текущая позиция.
    // Пошив закрывается через OPERATION_FINISHED, ОТК — QC_PASSED, ВТО —
    // WTO_PASSED, упаковка — PACKED; все четыре несут operationId шага.
    // Без всех четырёх типов drill не узнаёт прошедших ОТК/ВТО/упаковку
    // (они «закрылись» не OPERATION_FINISHED) — и список по клику расходился
    // с числом в ячейке, которое getBoard уже считает по этим же событиям.
    const finishedOpsByPassport = new Map<string, Set<string>>();
    if (candidates.length > 0) {
      const finRows = await this.prisma.passportEvent.findMany({
        where: {
          passportId: { in: candidates.map((p) => p.id) },
          type: {
            in: [
              PassportEventType.OPERATION_FINISHED,
              PassportEventType.QC_PASSED,
              PassportEventType.WTO_PASSED,
              PassportEventType.PACKED,
            ],
          },
          operationId: { not: null },
        },
        select: { passportId: true, operationId: true },
      });
      for (const ev of finRows) {
        if (!ev.operationId) continue;
        let s = finishedOpsByPassport.get(ev.passportId);
        if (!s) {
          s = new Set();
          finishedOpsByPassport.set(ev.passportId, s);
        }
        s.add(ev.operationId);
      }
    }

    const sewingShiftByEmployee = new Map<
      string,
      { id: string; code: string }
    >();
    {
      const shifts = await this.prisma.shiftSession.findMany({
        where: {
          endedAt: null,
          operation: { category: OperationCategory.SEWING },
        },
        select: {
          employeeId: true,
          operation: { select: { id: true, code: true } },
        },
      });
      for (const s of shifts) {
        sewingShiftByEmployee.set(s.employeeId, {
          id: s.operation.id,
          code: s.operation.code,
        });
      }
    }

    // Метка + ID операции для атрибуции «буферных» паспортов финишёру
    // (см. `getBoard` → `finisherByPassportOp`).
    const opRow = await this.prisma.operation.findUnique({
      where: { code: query.stage },
      select: { id: true, name: true },
    });
    const stageLabel = opRow?.name ?? query.stage;
    const stageOpId = opRow?.id ?? null;

    // Финишёры по паспортам кандидатам на ИМЕННО ЭТОЙ операции.
    // Если у паспорта `currentEmployeeId = null` И есть закрывающее событие
    // на `stageOpId` (OPERATION_FINISHED — пошив, QC_PASSED — ОТК,
    // WTO_PASSED — ВТО, PACKED — упаковка), атрибутируем группе финишёра
    // с `released:true` (раздельный блок «✔ Имя»). Без финишёра
    // (data drift / откат маршрута) — fallback анонимная «В буфере».
    const finisherByPassport = new Map<
      string,
      { id: string; fullName: string }
    >();
    if (stageOpId && candidates.length > 0) {
      const events = await this.prisma.passportEvent.findMany({
        where: {
          passportId: { in: candidates.map((p) => p.id) },
          type: {
            in: [
              PassportEventType.OPERATION_FINISHED,
              PassportEventType.QC_PASSED,
              PassportEventType.WTO_PASSED,
              PassportEventType.PACKED,
            ],
          },
          operationId: stageOpId,
        },
        select: {
          passportId: true,
          createdAt: true,
          employee: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      for (const ev of events) {
        if (!ev.employee || finisherByPassport.has(ev.passportId)) continue;
        finisherByPassport.set(ev.passportId, {
          id: ev.employee.id,
          fullName: ev.employee.fullName,
        });
      }
    }

    const NO_EMP = '__none__';
    const groups = new Map<string, ProductionBoardDrillEmployeeGroupDto>();
    for (const p of candidates) {
      const orderId = p.orderId ?? '';
      // Колонка неприменима, если операции нет в маршруте заказа.
      const colIdx = stageOpId
        ? opIndexByOrder.get(orderId)?.get(stageOpId)
        : undefined;
      if (colIdx === undefined) continue;

      // ПО-ОПЕРАЦИОННО (зеркало getBoard): колонка отражает только то,
      // что реально было НА этой операции.
      //   - ВЫПУЩЕНО (released:true): есть закрывающее событие именно на X
      //     (OPERATION_FINISHED/QC_PASSED/WTO_PASSED/PACKED) → финишёр X
      //     (`finisherByPassport`), иначе «Закрыто» (без исполнителя — редко);
      //   - В РАБОТЕ (released:false): активно работает X и ещё не закрыл.
      // Проскоченную без скана операцию паспорт не «касается» → 0.
      const finishedThisOp =
        stageOpId !== null &&
        (finishedOpsByPassport.get(p.id)?.has(stageOpId) ?? false);
      const op = this.resolveColumnOp(
        p,
        sewingShiftByEmployee,
        opByOrderIndex,
      );
      const currentlyHere = op?.code === query.stage;

      let gEmployeeId: string | null;
      let gEmployeeName: string;
      let gReleased: boolean;
      if (finishedThisOp) {
        gReleased = true;
        const finisher = finisherByPassport.get(p.id);
        if (finisher) {
          gEmployeeId = finisher.id;
          gEmployeeName = finisher.fullName;
        } else {
          gEmployeeId = null;
          gEmployeeName = 'Закрыто';
        }
      } else if (currentlyHere && p.currentEmployeeId !== null) {
        gReleased = false;
        gEmployeeId = p.currentEmployeeId;
        gEmployeeName = p.currentEmployee?.fullName ?? '—';
      } else {
        continue; // паспорт не касался этой стадии
      }

      // Фильтр `query.employeeId` — матчит и активного, и финишёра
      // (мастер может кликнуть на любую плашку).
      if (query.employeeId && gEmployeeId !== query.employeeId) continue;

      const row: ProductionBoardPassportRowDto = {
        passportId: p.id,
        number: p.number,
        sizeCode: p.size?.code ?? '—',
        qty: p.qtyCut,
        defects: p.qtyDefect,
        employeeName: gEmployeeName === '—' ? null : gEmployeeName,
      };
      const gKey =
        (gEmployeeId ?? NO_EMP) + (gReleased ? ':released' : ':active');
      let g = groups.get(gKey);
      if (!g) {
        g = {
          employeeId: gEmployeeId,
          employeeName: gEmployeeName,
          passports: 0,
          qty: 0,
          defects: 0,
          released: gReleased,
          rows: [],
        };
        groups.set(gKey, g);
      }
      g.rows.push(row);
      g.passports += 1;
      g.qty += p.qtyCut;
      g.defects += p.qtyDefect;
    }

    const groupList = [...groups.values()].sort((a, b) => {
      // Активная работа сверху, выпущенные — ниже; по убыванию паспортов
      // внутри каждой группы.
      if (a.released !== b.released) return a.released ? 1 : -1;
      return b.passports - a.passports;
    });
    return {
      issueDate: query.issueDate,
      stageLabel,
      totalPassports: groupList.reduce((s, g) => s + g.passports, 0),
      totalQty: groupList.reduce((s, g) => s + g.qty, 0),
      totalDefects: groupList.reduce((s, g) => s + g.defects, 0),
      groups: groupList,
    };
  }
}
