import { Injectable } from '@nestjs/common';
import {
  OperationCategory,
  OrderStatus,
  PassportStatus,
} from '@prisma/client';
import type {
  DiagnosticConsistencyReportDto,
  DiagnosticIssueDto,
  DiagnosticSeverity,
} from '@sewing/shared/diagnostics';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Жёсткий потолок строк на одну проверку. Защита от deg-режима:
 * если по какой-то причине БД накопила тысячи «битых» паспортов,
 * мы не возвращаем простыню — UI покажет первые `LIMIT_PER_CHECK`,
 * остальные ждут, пока менеджер разберёт верхушку.
 */
const LIMIT_PER_CHECK = 200;

/**
 * Категории операций, которые маршрут производства (`OrderRouteStep`)
 * на MVP сознательно НЕ покрывает: ОТК, ВТО, упаковка — это
 * терминальные стадии после маршрута. Используются как исключение в
 * `PASSPORT_CURRENT_OPERATION_NOT_IN_ORDER_ROUTE`: если паспорт
 * сейчас на одной из этих категорий, отсутствие операции в маршруте
 * — норма, а не находка.
 *
 * `CUTTING` здесь по той же причине, по которой маршрутные гейты в
 * `PassportsService` ограничены `SEWING`: крой закрывается при выпуске
 * паспорта, а не через `OPERATION_FINISHED`, и каждый паспорт рождается
 * на «Делении кроя» независимо от того, стоит ли эта операция в снимке
 * маршрута. Без этого исключения проверка G выдавала на проде 333
 * находки «Деление кроя / статус СОЗДАН» из 394 — 85% чистого шума, в
 * котором тонули реальные 61. Именно поэтому она не поймала НИ ОДИН из
 * шести инцидентов «работа мимо маршрута» (13.05-28.07.2026).
 */
const POST_ROUTE_CATEGORIES: ReadonlySet<OperationCategory> = new Set([
  OperationCategory.QC,
  OperationCategory.IRONING,
  OperationCategory.PACKING,
  OperationCategory.CUTTING,
]);

/**
 * Окно проверки V (`ORDER_WORK_OUTSIDE_ROUTE`). У `OrderRouteStep` нет
 * ни `createdAt`, ни `updatedAt`, поэтому отличить «работали мимо
 * маршрута» от «маршрут переписали ПОСЛЕ работы» невозможно —
 * скользящее окно ограничивает исторический хвост тем, что ещё можно
 * разобрать по горячим следам.
 */
const OFF_ROUTE_WINDOW_DAYS = 30;

/**
 * Diagnostic consistency report — единый сервис всех read-only
 * проверок «невозможных» состояний домена.
 *
 * Жёсткие инварианты модуля:
 *   - НИКАКИХ `update` / `delete` / `create` / `upsert` / raw write —
 *     только `findMany` / `groupBy` / `count` / `$queryRaw` (только
 *     SELECT). Smoke-тест `diagnostics-admin.smoke.test.ts` это
 *     гарантирует grep-ом по исходнику;
 *   - каждая проверка ограничена `LIMIT_PER_CHECK`;
 *   - context каждого issue — минимально полезный JSON-срез, без
 *     полного снапшота сущности.
 *
 * Подробное описание checks — см. `docs/ops.md §«Diagnostics»` и
 * `docs/domain.md §«Diagnostic consistency report»`.
 */
@Injectable()
export class DiagnosticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getConsistencyReport(): Promise<DiagnosticConsistencyReportDto> {
    const issues: DiagnosticIssueDto[] = [];

    await this.checkPassportIssues(issues);
    await this.checkRouteIssues(issues);
    await this.checkOffRouteWorkIssues(issues);
    await this.checkShiftEquipmentIssues(issues);
    await this.checkOrderIssues(issues);
    await this.checkStorageIssues(issues);

    const sorted = sortIssues(issues);
    const critical = sorted.filter((i) => i.severity === 'CRITICAL').length;
    const warning = sorted.filter((i) => i.severity === 'WARNING').length;

    return {
      generatedAt: new Date().toISOString(),
      summary: { total: sorted.length, critical, warning },
      issues: sorted,
    };
  }

  // ---------------------------------------------------------------------------
  // Passports (A–E)
  // ---------------------------------------------------------------------------

  private async checkPassportIssues(out: DiagnosticIssueDto[]): Promise<void> {
    // A. PASSPORT_IN_PROGRESS_WITHOUT_EMPLOYEE
    //
    // Паспорт IN_PROGRESS без активного сотрудника. Это норма в
    // буфере между операциями (партия лежит в ячейке, ждёт следующего
    // шага), поэтому:
    //   - есть `currentRouteStepIndex` ИЛИ есть `currentCellId`  → WARNING
    //     (лежит в буфере / маршрут указывает следующий шаг);
    //   - нет ни маршрутного индекса, ни ячейки, ни сотрудника       → CRITICAL
    //     (паспорт «висит в воздухе»: непонятно, кто должен взять).
    const orphanInProgress = await this.prisma.passport.findMany({
      where: {
        status: PassportStatus.IN_PROGRESS,
        currentEmployeeId: null,
      },
      select: {
        id: true,
        number: true,
        orderId: true,
        currentCellId: true,
        currentRouteStepIndex: true,
        currentOperationId: true,
        updatedAt: true,
      },
      take: LIMIT_PER_CHECK,
    });
    for (const p of orphanInProgress) {
      const inBuffer =
        p.currentCellId !== null || p.currentRouteStepIndex !== null;
      out.push({
        code: 'PASSPORT_IN_PROGRESS_WITHOUT_EMPLOYEE',
        severity: inBuffer ? 'WARNING' : 'CRITICAL',
        entityType: 'PASSPORT',
        entityId: p.id,
        message: inBuffer
          ? `Паспорт ${p.number} в работе без сотрудника, но лежит в буфере (ячейка/маршрут).`
          : `Паспорт ${p.number} в работе без сотрудника и без буфера — «висит в воздухе».`,
        context: {
          number: p.number,
          orderId: p.orderId,
          currentCellId: p.currentCellId,
          currentOperationId: p.currentOperationId,
          currentRouteStepIndex: p.currentRouteStepIndex,
          updatedAt: p.updatedAt.toISOString(),
        },
      });
    }

    // B. PASSPORT_HAS_EMPLOYEE_BUT_NOT_IN_PROGRESS
    //
    // У паспорта проставлен `currentEmployeeId`, но статус не
    // IN_PROGRESS. По текущей доменной логике `currentEmployeeId`
    // выставляется только при выдаче кроя швее (`ISSUED_TO_EMPLOYEE`)
    // и снимается при завершении операции / упаковке. Любое другое
    // состояние = рассинхронизация (ничего критического для денег,
    // но картинка цеха будет врать).
    const employeeWithoutInProgress = await this.prisma.passport.findMany({
      where: {
        currentEmployeeId: { not: null },
        status: { not: PassportStatus.IN_PROGRESS },
      },
      select: {
        id: true,
        number: true,
        status: true,
        currentEmployeeId: true,
        updatedAt: true,
      },
      take: LIMIT_PER_CHECK,
    });
    for (const p of employeeWithoutInProgress) {
      out.push({
        code: 'PASSPORT_HAS_EMPLOYEE_BUT_NOT_IN_PROGRESS',
        severity: 'WARNING',
        entityType: 'PASSPORT',
        entityId: p.id,
        message: `У паспорта ${p.number} (status=${p.status}) проставлен текущий сотрудник, но он не в работе.`,
        context: {
          number: p.number,
          status: p.status,
          currentEmployeeId: p.currentEmployeeId,
          updatedAt: p.updatedAt.toISOString(),
        },
      });
    }

    // C. PASSPORT_IN_BOX_BUT_STILL_WIP
    //
    // Паспорт уже физически в коробке (`BoxItem`), но всё ещё помечен
    // IN_PROGRESS или с активным сотрудником. Это критично для
    // производственного учёта: упакованная партия не должна
    // фигурировать в WIP-метриках.
    const inBoxWip = await this.prisma.passport.findMany({
      where: {
        boxItems: { some: {} },
        OR: [
          { status: PassportStatus.IN_PROGRESS },
          { currentEmployeeId: { not: null } },
        ],
      },
      select: {
        id: true,
        number: true,
        status: true,
        currentEmployeeId: true,
        boxItems: { select: { boxId: true }, take: 1 },
      },
      take: LIMIT_PER_CHECK,
    });
    for (const p of inBoxWip) {
      out.push({
        code: 'PASSPORT_IN_BOX_BUT_STILL_WIP',
        severity: 'CRITICAL',
        entityType: 'PASSPORT',
        entityId: p.id,
        message: `Паспорт ${p.number} уже в коробке, но помечен как WIP (status=${p.status}, employee=${p.currentEmployeeId ?? '∅'}).`,
        context: {
          number: p.number,
          status: p.status,
          currentEmployeeId: p.currentEmployeeId,
          boxId: p.boxItems[0]?.boxId ?? null,
        },
      });
    }

    // D. PASSPORT_FINISHED_BUT_HAS_CURRENT_EMPLOYEE
    //
    // Терминальный статус (`PACKED`) + проставлен `currentEmployeeId`.
    // Это означает, что мы посчитали партию упакованной, но не
    // отвязали от исполнителя — backend rendering UI покажет «у
    // сотрудника на руках».
    const packedWithEmployee = await this.prisma.passport.findMany({
      where: {
        status: PassportStatus.PACKED,
        currentEmployeeId: { not: null },
      },
      select: {
        id: true,
        number: true,
        currentEmployeeId: true,
        updatedAt: true,
      },
      take: LIMIT_PER_CHECK,
    });
    for (const p of packedWithEmployee) {
      out.push({
        code: 'PASSPORT_FINISHED_BUT_HAS_CURRENT_EMPLOYEE',
        severity: 'CRITICAL',
        entityType: 'PASSPORT',
        entityId: p.id,
        message: `Паспорт ${p.number} упакован, но всё ещё закреплён за сотрудником.`,
        context: {
          number: p.number,
          currentEmployeeId: p.currentEmployeeId,
          updatedAt: p.updatedAt.toISOString(),
        },
      });
    }

    // E. PASSPORT_CANCELLED_BUT_ACTIVE_ASSIGNMENT
    //
    // Отменённый паспорт не должен быть нигде «активен»: ни у
    // сотрудника, ни в ячейке. Это WARNING — деньги/упаковка не
    // ломаются, но в UI будет выглядеть странно.
    const cancelledWithAssignment = await this.prisma.passport.findMany({
      where: {
        status: PassportStatus.CANCELLED,
        OR: [
          { currentEmployeeId: { not: null } },
          { currentCellId: { not: null } },
        ],
      },
      select: {
        id: true,
        number: true,
        currentEmployeeId: true,
        currentCellId: true,
      },
      take: LIMIT_PER_CHECK,
    });
    for (const p of cancelledWithAssignment) {
      out.push({
        code: 'PASSPORT_CANCELLED_BUT_ACTIVE_ASSIGNMENT',
        severity: 'WARNING',
        entityType: 'PASSPORT',
        entityId: p.id,
        message: `Отменённый паспорт ${p.number} всё ещё закреплён за сотрудником/ячейкой.`,
        context: {
          number: p.number,
          currentEmployeeId: p.currentEmployeeId,
          currentCellId: p.currentCellId,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Route consistency (F–I)
  // ---------------------------------------------------------------------------

  private async checkRouteIssues(out: DiagnosticIssueDto[]): Promise<void> {
    // Подгружаем для каждого заказа набор операций маршрута (`Set`)
    // и максимальный индекс — это нужно сразу для F и G. Один общий
    // запрос дешевле, чем считать `count`/`exists` для каждого
    // паспорта по отдельности.
    const passportsWithRoute = await this.prisma.passport.findMany({
      where: {
        OR: [
          { currentRouteStepIndex: { not: null } },
          { currentOperationId: { not: null } },
        ],
        // Отменённые сюда сознательно не тянем — для них уже есть E.
        status: { not: PassportStatus.CANCELLED },
      },
      select: {
        id: true,
        number: true,
        orderId: true,
        status: true,
        currentRouteStepIndex: true,
        currentOperationId: true,
      },
      // Срез обязан быть детерминированным: без `orderBy` БД вольна
      // вернуть любые `take` строк, и отчёт «прыгал» бы от запуска к
      // запуску, показывая то одни находки, то другие. Свежие сверху —
      // по ним ещё можно что-то сделать.
      orderBy: { createdAt: 'desc' },
      take: LIMIT_PER_CHECK * 4, // до 4-х проверок по этому набору
    });

    if (passportsWithRoute.length > 0) {
      const orderIds = Array.from(
        new Set(passportsWithRoute.map((p) => p.orderId)),
      );
      const routeRows = await this.prisma.orderRouteStep.findMany({
        where: { orderId: { in: orderIds } },
        select: { orderId: true, index: true, operationId: true },
      });
      const routeByOrder = new Map<
        string,
        { indexes: Set<number>; operationIds: Set<string>; maxIndex: number }
      >();
      for (const r of routeRows) {
        let entry = routeByOrder.get(r.orderId);
        if (!entry) {
          entry = {
            indexes: new Set<number>(),
            operationIds: new Set<string>(),
            maxIndex: -1,
          };
          routeByOrder.set(r.orderId, entry);
        }
        entry.indexes.add(r.index);
        entry.operationIds.add(r.operationId);
        if (r.index > entry.maxIndex) entry.maxIndex = r.index;
      }

      // Подтягиваем категории операций для исключений в G — лениво,
      // только если у паспорта есть `currentOperationId`.
      const opIds = Array.from(
        new Set(
          passportsWithRoute
            .map((p) => p.currentOperationId)
            .filter((v): v is string => v !== null),
        ),
      );
      const opCategoryById = new Map<string, OperationCategory>();
      if (opIds.length > 0) {
        const opRows = await this.prisma.operation.findMany({
          where: { id: { in: opIds } },
          select: { id: true, category: true },
        });
        for (const op of opRows) opCategoryById.set(op.id, op.category);
      }

      // Правила взаимозаменяемости (`OperationSubstitution`) и статусы
      // заказов — исключения для G. Закрытие заместителя засчитывает
      // замещаемую операцию (см. `PassportsService.evaluateRouteOrder`),
      // поэтому паспорт на «полном РАСПОШИВЕ» при сплит-маршруте — это
      // норма, а не находка. По `DONE`/`CANCELLED` заказам разбирать
      // нечего: находка провисит в отчёте вечно и приучит к тому, что
      // «там всегда что-то горит».
      const substitutions = await this.loadSubstitutesBySatisfied();
      const orderStatusById = new Map<string, OrderStatus>();
      const orderRows = await this.prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, status: true },
      });
      for (const o of orderRows) orderStatusById.set(o.id, o.status);

      let fCount = 0;
      let gCount = 0;
      for (const p of passportsWithRoute) {
        const route = routeByOrder.get(p.orderId);

        // F. PASSPORT_ROUTE_INDEX_OUT_OF_RANGE
        //
        // У паспорта стоит индекс шага маршрута, но в snapshot
        // `OrderRouteStep` такого индекса нет. Скорее всего, маршрут
        // был сужен/удалён руками после snapshot-а — критическая
        // рассинхронизация.
        if (
          p.currentRouteStepIndex !== null &&
          fCount < LIMIT_PER_CHECK &&
          (!route || !route.indexes.has(p.currentRouteStepIndex))
        ) {
          out.push({
            code: 'PASSPORT_ROUTE_INDEX_OUT_OF_RANGE',
            severity: 'CRITICAL',
            entityType: 'PASSPORT',
            entityId: p.id,
            message: `У паспорта ${p.number} индекс шага маршрута (${p.currentRouteStepIndex}) отсутствует в snapshot заказа.`,
            context: {
              number: p.number,
              orderId: p.orderId,
              currentRouteStepIndex: p.currentRouteStepIndex,
              maxRouteIndex: route?.maxIndex ?? null,
              routeStepsCount: route?.indexes.size ?? 0,
            },
          });
          fCount += 1;
        }

        // G. PASSPORT_CURRENT_OPERATION_NOT_IN_ORDER_ROUTE
        //
        // Текущая операция паспорта не входит в snapshot маршрута.
        // Пропускаем, если это норма, а не находка:
        //   - терминальная/кроевая категория (см. POST_ROUTE_CATEGORIES);
        //   - у заказа вообще нет snapshot-а (F/G нерелевантны);
        //   - паспорт ещё `CREATED` — он не в работе, его операция это
        //     артефакт выпуска, а не факт цеха;
        //   - заказ уже закрыт (`DONE`/`CANCELLED`) — разбирать нечего;
        //   - операция ЗАМЕЩАЕТ шаг маршрута по `OperationSubstitution`.
        //
        // Severity `CRITICAL`, а не `WARNING`: это не «странность в
        // данных», а работа, которая не засчитается на гейте перед ОТК —
        // партия встанет через недели, сразу десятками паспортов.
        if (
          p.currentOperationId !== null &&
          gCount < LIMIT_PER_CHECK &&
          route !== undefined &&
          route.operationIds.size > 0 &&
          !route.operationIds.has(p.currentOperationId)
        ) {
          const cat = opCategoryById.get(p.currentOperationId);
          if (cat && POST_ROUTE_CATEGORIES.has(cat)) continue;
          if (p.status === PassportStatus.CREATED) continue;
          const orderStatus = orderStatusById.get(p.orderId);
          if (
            orderStatus === OrderStatus.DONE ||
            orderStatus === OrderStatus.CANCELLED
          ) {
            continue;
          }
          if (
            isSatisfiedBySubstitute(
              p.currentOperationId,
              route.operationIds,
              substitutions,
            )
          ) {
            continue;
          }
          out.push({
            code: 'PASSPORT_CURRENT_OPERATION_NOT_IN_ORDER_ROUTE',
            severity: 'CRITICAL',
            entityType: 'PASSPORT',
            entityId: p.id,
            message: `Текущая операция паспорта ${p.number} не входит в маршрут заказа — эта работа не засчитается на гейте перед ОТК.`,
            context: {
              number: p.number,
              orderId: p.orderId,
              currentOperationId: p.currentOperationId,
              currentOperationCategory: cat ?? null,
              routeOperationCount: route.operationIds.size,
            },
          });
          gCount += 1;
        }
      }
    }

    // H. ORDER_IN_PRODUCTION_WITHOUT_ROUTE_STEPS_BUT_ROUTE_TEMPLATE
    //
    // У заказа выбран `routeTemplateId`, заказ уже в `IN_PRODUCTION`,
    // а snapshot `OrderRouteStep[]` пуст. Это значит, что
    // `OrdersService.start()` не отработал по маршруту (или его
    // удалили) — паспорта по такому заказу будут идти «вне маршрута».
    const ordersInProdNoSteps = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.IN_PRODUCTION,
        routeTemplateId: { not: null },
        routeSteps: { none: {} },
      },
      select: { id: true, number: true, routeTemplateId: true },
      take: LIMIT_PER_CHECK,
    });
    for (const o of ordersInProdNoSteps) {
      out.push({
        code: 'ORDER_IN_PRODUCTION_WITHOUT_ROUTE_STEPS_BUT_ROUTE_TEMPLATE',
        severity: 'WARNING',
        entityType: 'ORDER',
        entityId: o.id,
        message: `Заказ ${o.number} в производстве с шаблоном маршрута, но snapshot пуст.`,
        context: {
          number: o.number,
          routeTemplateId: o.routeTemplateId,
        },
      });
    }

    // I. PASSPORT_ROUTE_STEP_DONE_BUT_ORDER_NOT_IN_PRODUCTION
    //
    // У паспорта проставлен `currentRouteStepIndex`, но заказ ещё
    // `DRAFT` или уже `CANCELLED`. По нормальному flow snapshot и
    // индекс появляются только после `OrdersService.start()` —
    // сочетание индикативно для ручной правки БД.
    const passportsRouteWithBadOrder = await this.prisma.passport.findMany({
      where: {
        currentRouteStepIndex: { not: null },
        order: {
          status: { in: [OrderStatus.DRAFT, OrderStatus.CANCELLED] },
        },
      },
      select: {
        id: true,
        number: true,
        orderId: true,
        currentRouteStepIndex: true,
        order: { select: { number: true, status: true } },
      },
      take: LIMIT_PER_CHECK,
    });
    for (const p of passportsRouteWithBadOrder) {
      out.push({
        code: 'PASSPORT_ROUTE_STEP_DONE_BUT_ORDER_NOT_IN_PRODUCTION',
        severity: 'WARNING',
        entityType: 'PASSPORT',
        entityId: p.id,
        message: `У паспорта ${p.number} есть индекс маршрута, но заказ ${p.order.number} в статусе ${p.order.status}.`,
        context: {
          number: p.number,
          orderId: p.orderId,
          orderStatus: p.order.status,
          currentRouteStepIndex: p.currentRouteStepIndex,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Shifts / Equipment (J–N)
  // ---------------------------------------------------------------------------

  private async checkShiftEquipmentIssues(
    out: DiagnosticIssueDto[],
  ): Promise<void> {
    // J. EMPLOYEE_MULTIPLE_ACTIVE_SHIFTS
    //
    // Двойная активная смена на одного сотрудника. На MVP это
    // защищено partial unique индексом (см. ADR-0015), но мы всё
    // равно проверяем — отчёт должен ловить ручные SQL-правки.
    const employeeShiftDup = await this.prisma.shiftSession.groupBy({
      by: ['employeeId'],
      where: { endedAt: null },
      _count: { _all: true },
      having: { employeeId: { _count: { gt: 1 } } },
    });
    for (const row of employeeShiftDup) {
      out.push({
        code: 'EMPLOYEE_MULTIPLE_ACTIVE_SHIFTS',
        severity: 'CRITICAL',
        entityType: 'EMPLOYEE',
        entityId: row.employeeId,
        message: `У сотрудника одновременно открыто ${row._count._all} смен.`,
        context: {
          employeeId: row.employeeId,
          activeShiftCount: row._count._all,
        },
      });
    }

    // K. EQUIPMENT_MULTIPLE_ACTIVE_SHIFTS
    //
    // На одном станке открыто несколько активных смен. На MVP схема
    // это допускает (нет unique-индекса), но фактически менеджер
    // ожидает одну смену на станок: WARNING, чтобы не пугать
    // ложными CRITICAL'ами там, где БД формально молчит.
    const equipmentShiftDup = await this.prisma.shiftSession.groupBy({
      by: ['equipmentId'],
      where: { endedAt: null },
      _count: { _all: true },
      having: { equipmentId: { _count: { gt: 1 } } },
    });
    for (const row of equipmentShiftDup) {
      out.push({
        code: 'EQUIPMENT_MULTIPLE_ACTIVE_SHIFTS',
        severity: 'WARNING',
        entityType: 'EQUIPMENT',
        entityId: row.equipmentId,
        message: `На оборудовании одновременно открыто ${row._count._all} смен.`,
        context: {
          equipmentId: row.equipmentId,
          activeShiftCount: row._count._all,
        },
      });
    }

    // L + M + N: единичные активные смены, у которых что-то не так
    // с equipment / employee / связкой equipment↔operation. Один
    // запрос — три проверки.
    const activeShifts = await this.prisma.shiftSession.findMany({
      where: { endedAt: null },
      select: {
        id: true,
        employeeId: true,
        equipmentId: true,
        operationId: true,
        equipment: {
          select: {
            active: true,
            allowedOperations: {
              where: { isActive: true },
              select: { operationId: true },
            },
          },
        },
        employee: { select: { active: true } },
      },
      take: LIMIT_PER_CHECK,
    });
    for (const s of activeShifts) {
      // L. ACTIVE_SHIFT_ON_INACTIVE_EQUIPMENT
      if (!s.equipment.active) {
        out.push({
          code: 'ACTIVE_SHIFT_ON_INACTIVE_EQUIPMENT',
          severity: 'WARNING',
          entityType: 'SHIFT',
          entityId: s.id,
          message: `Активная смена ведётся на отключённом оборудовании.`,
          context: {
            shiftId: s.id,
            employeeId: s.employeeId,
            equipmentId: s.equipmentId,
            operationId: s.operationId,
          },
        });
      }

      // M. ACTIVE_SHIFT_WITH_INACTIVE_EMPLOYEE
      if (!s.employee.active) {
        out.push({
          code: 'ACTIVE_SHIFT_WITH_INACTIVE_EMPLOYEE',
          severity: 'WARNING',
          entityType: 'SHIFT',
          entityId: s.id,
          message: `Активная смена закреплена за деактивированным сотрудником.`,
          context: {
            shiftId: s.id,
            employeeId: s.employeeId,
            equipmentId: s.equipmentId,
            operationId: s.operationId,
          },
        });
      }

      // N. ACTIVE_SHIFT_OPERATION_NOT_ALLOWED_ON_EQUIPMENT
      //
      // Сотрудник работает на станке по операции, которая в
      // `EquipmentOperation` для этого станка не разрешена. Это
      // CRITICAL: либо сдельные ставки/маршруты считаются неправильно,
      // либо смена была заведена в обход админ-формы.
      const allowed = new Set(
        s.equipment.allowedOperations.map((eo) => eo.operationId),
      );
      if (!allowed.has(s.operationId)) {
        out.push({
          code: 'ACTIVE_SHIFT_OPERATION_NOT_ALLOWED_ON_EQUIPMENT',
          severity: 'CRITICAL',
          entityType: 'SHIFT',
          entityId: s.id,
          message: `Активная смена идёт по операции, не разрешённой на этом оборудовании.`,
          context: {
            shiftId: s.id,
            employeeId: s.employeeId,
            equipmentId: s.equipmentId,
            operationId: s.operationId,
            allowedOperationCount: allowed.size,
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Orders (O, P, Q)
  // ---------------------------------------------------------------------------

  private async checkOrderIssues(out: DiagnosticIssueDto[]): Promise<void> {
    // Полезный helper: «активный» паспорт = всё, что не PACKED/CANCELLED
    // или у чего проставлен currentEmployeeId.
    const activePassportFilter = {
      OR: [
        { status: PassportStatus.IN_PROGRESS },
        { status: PassportStatus.CREATED },
        { currentEmployeeId: { not: null } },
      ],
    };

    // O. ORDER_DONE_WITH_ACTIVE_PASSPORTS
    const doneOrdersWithActive = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.DONE,
        passports: { some: activePassportFilter },
      },
      select: {
        id: true,
        number: true,
        _count: { select: { passports: true } },
      },
      take: LIMIT_PER_CHECK,
    });
    for (const o of doneOrdersWithActive) {
      const activeCount = await this.prisma.passport.count({
        where: { orderId: o.id, ...activePassportFilter },
      });
      out.push({
        code: 'ORDER_DONE_WITH_ACTIVE_PASSPORTS',
        severity: 'CRITICAL',
        entityType: 'ORDER',
        entityId: o.id,
        message: `Заказ ${o.number} закрыт (DONE), но по нему остались живые паспорта (${activeCount}).`,
        context: {
          number: o.number,
          activePassports: activeCount,
          totalPassports: o._count.passports,
        },
      });
    }

    // P. ORDER_CANCELLED_WITH_ACTIVE_PASSPORTS
    const cancelledOrdersWithActive = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.CANCELLED,
        passports: { some: activePassportFilter },
      },
      select: { id: true, number: true },
      take: LIMIT_PER_CHECK,
    });
    for (const o of cancelledOrdersWithActive) {
      out.push({
        code: 'ORDER_CANCELLED_WITH_ACTIVE_PASSPORTS',
        severity: 'WARNING',
        entityType: 'ORDER',
        entityId: o.id,
        message: `Отменённый заказ ${o.number} имеет активные паспорта.`,
        context: { number: o.number },
      });
    }

    // Q. ORDER_ITEM_QTY_MISMATCH (advisory).
    //
    // На MVP частичные раскрои легитимны (помощник раскройщика
    // выпускает паспорта в несколько заходов), поэтому «фактический
    // qtyCut меньше qtyPlan» — это не находка. Но «qtyCut > qtyPlan»
    // = перекрой: либо план занижен, либо паспорт выпустили лишний
    // раз. WARNING.
    const passportSums = await this.prisma.passport.groupBy({
      by: ['orderId', 'productId', 'sizeId'],
      where: { status: { not: PassportStatus.CANCELLED } },
      _sum: { qtyCut: true },
    });
    if (passportSums.length > 0) {
      const itemKeys = passportSums.map((s) => ({
        orderId: s.orderId,
        productId: s.productId,
        sizeId: s.sizeId,
      }));
      const items = await this.prisma.orderItem.findMany({
        where: { OR: itemKeys },
        select: {
          id: true,
          orderId: true,
          productId: true,
          sizeId: true,
          qtyPlan: true,
        },
      });
      const planByKey = new Map<string, { id: string; qtyPlan: number }>();
      for (const it of items) {
        planByKey.set(itemKey(it.orderId, it.productId, it.sizeId), {
          id: it.id,
          qtyPlan: it.qtyPlan,
        });
      }
      let qCount = 0;
      for (const s of passportSums) {
        if (qCount >= LIMIT_PER_CHECK) break;
        const key = itemKey(s.orderId, s.productId, s.sizeId);
        const plan = planByKey.get(key);
        const cut = s._sum.qtyCut ?? 0;
        if (!plan || cut <= plan.qtyPlan) continue;
        out.push({
          code: 'ORDER_ITEM_QTY_MISMATCH',
          severity: 'WARNING',
          entityType: 'ORDER_ITEM',
          entityId: plan.id,
          message: `Сумма qtyCut по строке заказа (${cut}) превышает план (${plan.qtyPlan}).`,
          context: {
            orderId: s.orderId,
            productId: s.productId,
            sizeId: s.sizeId,
            qtyCut: cut,
            qtyPlan: plan.qtyPlan,
            overage: cut - plan.qtyPlan,
          },
        });
        qCount += 1;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cells / Boxes (R, T, U). S опускаем сознательно — FK у
  // WorkInProgressBalance на cell/size NOT NULL/optional корректно
  // защищены, обычной mutation эти инварианты сломать нельзя; для
  // отлова прямой ручной SQL-правки достаточно общего мониторинга
  // PostgreSQL.
  // ---------------------------------------------------------------------------

  private async checkStorageIssues(out: DiagnosticIssueDto[]): Promise<void> {
    // R. WORK_IN_PROGRESS_NEGATIVE — в ячейке отрицательный остаток
    // полуфабриката. Не должно происходить при нормальном flow,
    // потому что `applyMovementInTx` бросает `WIP_INSUFFICIENT_BALANCE`
    // на любой OUT, который увёл бы баланс ниже нуля.
    const negativeWip = await this.prisma.workInProgressBalance.findMany({
      where: { qty: { lt: 0 } },
      select: {
        id: true,
        cellId: true,
        sizeId: true,
        orderId: true,
        productId: true,
        color: true,
        qty: true,
      },
      take: LIMIT_PER_CHECK,
    });
    for (const b of negativeWip) {
      out.push({
        code: 'WORK_IN_PROGRESS_NEGATIVE',
        severity: 'CRITICAL',
        entityType: 'WORK_IN_PROGRESS_BALANCE',
        entityId: b.id,
        message: `Отрицательный остаток полуфабриката (${b.qty}).`,
        context: {
          cellId: b.cellId,
          sizeId: b.sizeId,
          orderId: b.orderId,
          productId: b.productId,
          color: b.color,
          qty: b.qty,
        },
      });
    }

    // T. BOX_CLOSED_BUT_EMPTY
    const closedEmpty = await this.prisma.box.findMany({
      where: {
        closedAt: { not: null },
        items: { none: {} },
      },
      select: { id: true, number: true, closedAt: true },
      take: LIMIT_PER_CHECK,
    });
    for (const b of closedEmpty) {
      out.push({
        code: 'BOX_CLOSED_BUT_EMPTY',
        severity: 'WARNING',
        entityType: 'BOX',
        entityId: b.id,
        message: `Коробка ${b.number} закрыта, но пуста.`,
        context: {
          number: b.number,
          closedAt: b.closedAt?.toISOString() ?? null,
        },
      });
    }

    // U. PASSPORT_IN_MULTIPLE_BOXES
    //
    // На MVP `BoxItem.passportId` имеет `@unique`, поэтому в норме
    // дубликат невозможен. Но проверка нужна на случай ручной правки
    // БД (или будущего изменения модели), как и J.
    const dupBoxItems = await this.prisma.boxItem.groupBy({
      by: ['passportId'],
      _count: { _all: true },
      having: { passportId: { _count: { gt: 1 } } },
    });
    for (const row of dupBoxItems) {
      out.push({
        code: 'PASSPORT_IN_MULTIPLE_BOXES',
        severity: 'CRITICAL',
        entityType: 'PASSPORT',
        entityId: row.passportId,
        message: `Паспорт находится одновременно в ${row._count._all} коробках.`,
        context: {
          passportId: row.passportId,
          boxItemCount: row._count._all,
        },
      });
    }
  }

  /**
   * V. ORDER_WORK_OUTSIDE_ROUTE — работа, закрытая мимо маршрута заказа.
   *
   * Чем отличается от G. G смотрит на ТЕКУЩУЮ позицию паспорта и потому
   * слепа к главному сценарию: швея закрыла чужую операцию и уехала
   * дальше — `currentOperationId` уже другой, находки нет, а работа
   * мимо плана осталась. V смотрит на ИСТОРИЮ `OPERATION_FINISHED` и
   * ловит ровно тот класс, который шесть раз с 13.05.2026 всплывал
   * только на AND-гейте перед ОТК, недели спустя, сразу десятками
   * паспортов (инцидент 28.07: 70 паспортов в 8 заказах, лаг 27 дней).
   *
   * Единица находки — ПАРА (заказ, операция), а не паспорт: мастеру
   * нужно одно решение на всю пачку («так и должно быть» / «делают не
   * то»), а не 70 одинаковых строк.
   *
   * Зеркалит `scripts/ops/off-route-work-check.sql` — тот же набор
   * исключений (только `SEWING`, живые заказы, легальные замены),
   * проверенный на истории прода: запущенный 02.07.2026 показал бы
   * инцидент в первый же день.
   */
  private async checkOffRouteWorkIssues(
    out: DiagnosticIssueDto[],
  ): Promise<void> {
    const since = new Date(
      Date.now() - OFF_ROUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const events = await this.prisma.passportEvent.findMany({
      where: {
        type: 'OPERATION_FINISHED',
        createdAt: { gte: since },
        operationId: { not: null },
        operation: { category: OperationCategory.SEWING },
        passport: {
          order: {
            status: { notIn: [OrderStatus.DONE, OrderStatus.CANCELLED] },
          },
        },
      },
      select: {
        createdAt: true,
        operationId: true,
        passportId: true,
        operation: { select: { code: true, name: true } },
        employee: { select: { fullName: true } },
        passport: {
          select: { orderId: true, order: { select: { number: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (events.length === 0) return;

    const orderIds = Array.from(
      new Set(events.map((e) => e.passport.orderId)),
    );
    const routeRows = await this.prisma.orderRouteStep.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, operationId: true },
    });
    const routeByOrder = new Map<string, Set<string>>();
    for (const r of routeRows) {
      let set = routeByOrder.get(r.orderId);
      if (!set) {
        set = new Set<string>();
        routeByOrder.set(r.orderId, set);
      }
      set.add(r.operationId);
    }
    const substitutions = await this.loadSubstitutesBySatisfied();

    // Сворачиваем в пары (заказ, операция).
    const groups = new Map<
      string,
      {
        orderId: string;
        orderNumber: string;
        operationId: string;
        operationLabel: string;
        passportIds: Set<string>;
        employees: Set<string>;
        firstAt: Date;
        lastAt: Date;
      }
    >();
    for (const e of events) {
      const opId = e.operationId;
      if (!opId) continue;
      const route = routeByOrder.get(e.passport.orderId);
      // Нет снимка маршрута — сравнивать не с чем (это отдельная
      // находка H, здесь дублировать её нельзя).
      if (!route || route.size === 0) continue;
      if (route.has(opId)) continue;
      if (isSatisfiedBySubstitute(opId, route, substitutions)) continue;

      const key = `${e.passport.orderId} ${opId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.passportIds.add(e.passportId);
        if (e.employee?.fullName) existing.employees.add(e.employee.fullName);
        if (e.createdAt < existing.firstAt) existing.firstAt = e.createdAt;
        if (e.createdAt > existing.lastAt) existing.lastAt = e.createdAt;
        continue;
      }
      groups.set(key, {
        orderId: e.passport.orderId,
        orderNumber: e.passport.order?.number ?? e.passport.orderId,
        operationId: opId,
        operationLabel: `${e.operation?.code ?? '?'} ${e.operation?.name ?? ''}`.trim(),
        passportIds: new Set([e.passportId]),
        employees: new Set(e.employee?.fullName ? [e.employee.fullName] : []),
        firstAt: e.createdAt,
        lastAt: e.createdAt,
      });
    }

    const sorted = [...groups.values()]
      .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime())
      .slice(0, LIMIT_PER_CHECK);
    for (const g of sorted) {
      out.push({
        code: 'ORDER_WORK_OUTSIDE_ROUTE',
        severity: 'CRITICAL',
        entityType: 'ORDER',
        entityId: g.orderId,
        message: `По заказу ${g.orderNumber} закрывают операцию «${g.operationLabel}», которой нет в его маршруте: паспортов — ${g.passportIds.size}, с ${formatDay(g.firstAt)}.`,
        context: {
          orderNumber: g.orderNumber,
          operationId: g.operationId,
          operation: g.operationLabel,
          passportCount: g.passportIds.size,
          firstAt: g.firstAt.toISOString(),
          lastAt: g.lastAt.toISOString(),
          employees: [...g.employees],
        },
      });
    }
  }

  /**
   * Карта «замещаемая операция → её заместители» из
   * `OperationSubstitution`. Таблица маленькая (единицы строк) и
   * читается целиком — дешевле, чем точечные запросы на каждую находку.
   */
  private async loadSubstitutesBySatisfied(): Promise<
    Map<string, Set<string>>
  > {
    const rows = await this.prisma.operationSubstitution.findMany({
      select: { satisfiesOpId: true, substituteOpId: true },
    });
    const bySatisfied = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = bySatisfied.get(r.satisfiesOpId);
      if (!set) {
        set = new Set<string>();
        bySatisfied.set(r.satisfiesOpId, set);
      }
      set.add(r.substituteOpId);
    }
    return bySatisfied;
  }
}

/**
 * Закрывает ли `operationId` какой-нибудь шаг маршрута легально —
 * то есть является ли он заместителем (`OperationSubstitution`) для
 * операции, которая в маршруте есть. Зеркалит `isSatisfied` в
 * `PassportsService.evaluateRouteOrder` и `QcService`.
 */
function isSatisfiedBySubstitute(
  operationId: string,
  routeOperationIds: ReadonlySet<string>,
  substitutesBySatisfied: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const routeOpId of routeOperationIds) {
    if (substitutesBySatisfied.get(routeOpId)?.has(operationId)) return true;
  }
  return false;
}

/** `дд.мм` в московской зоне — для человекочитаемого текста находки. */
function formatDay(d: Date): string {
  return d.toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  });
}

function itemKey(orderId: string, productId: string, sizeId: string): string {
  return `${orderId}\u0000${productId}\u0000${sizeId}`;
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
};

function sortIssues(issues: DiagnosticIssueDto[]): DiagnosticIssueDto[] {
  return [...issues].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    if (a.entityType !== b.entityType)
      return a.entityType.localeCompare(b.entityType);
    return a.entityId.localeCompare(b.entityId);
  });
}
