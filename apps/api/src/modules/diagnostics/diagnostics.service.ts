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
 */
const POST_ROUTE_CATEGORIES: ReadonlySet<OperationCategory> = new Set([
  OperationCategory.QC,
  OperationCategory.IRONING,
  OperationCategory.PACKING,
]);

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
        currentRouteStepIndex: true,
        currentOperationId: true,
      },
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
        // Если это терминальная категория (QC/IRONING/PACKING) — это
        // норма (маршрут MVP охватывает только пошив), пропускаем.
        // Если у заказа вообще нет snapshot-а — пропускаем (паспорт
        // живёт без маршрута, F/G здесь нерелевантны).
        if (
          p.currentOperationId !== null &&
          gCount < LIMIT_PER_CHECK &&
          route !== undefined &&
          route.operationIds.size > 0 &&
          !route.operationIds.has(p.currentOperationId)
        ) {
          const cat = opCategoryById.get(p.currentOperationId);
          if (cat && POST_ROUTE_CATEGORIES.has(cat)) continue;
          out.push({
            code: 'PASSPORT_CURRENT_OPERATION_NOT_IN_ORDER_ROUTE',
            severity: 'WARNING',
            entityType: 'PASSPORT',
            entityId: p.id,
            message: `Текущая операция паспорта ${p.number} не входит в snapshot маршрута заказа.`,
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
  // Cells / Boxes (R, T, U).  S опускаем сознательно — FK у CellContent
  // на cell/size NOT NULL, обычной mutation эту инвариант сломать
  // нельзя; для отлова прямой ручной SQL-правки достаточно общего
  // мониторинга PostgreSQL.
  // ---------------------------------------------------------------------------

  private async checkStorageIssues(out: DiagnosticIssueDto[]): Promise<void> {
    // R. CELL_CONTENT_NEGATIVE
    const negativeContents = await this.prisma.cellContent.findMany({
      where: { quantity: { lt: 0 } },
      select: { id: true, cellId: true, sizeId: true, quantity: true },
      take: LIMIT_PER_CHECK,
    });
    for (const c of negativeContents) {
      out.push({
        code: 'CELL_CONTENT_NEGATIVE',
        severity: 'CRITICAL',
        entityType: 'CELL_CONTENT',
        entityId: c.id,
        message: `В ячейке отрицательное количество (${c.quantity}).`,
        context: {
          cellId: c.cellId,
          sizeId: c.sizeId,
          quantity: c.quantity,
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
