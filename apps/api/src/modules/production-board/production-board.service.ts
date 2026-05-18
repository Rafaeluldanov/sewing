import { Injectable } from '@nestjs/common';
import { PassportEventType, PassportStatus } from '@prisma/client';
import {
  PRODUCTION_BOARD_RELEASED,
  PRODUCTION_BOARD_STAGES,
  type ProductionBoardCohortDto,
  type ProductionBoardDrillDto,
  type ProductionBoardDrillEmployeeGroupDto,
  type ProductionBoardDrillQuery,
  type ProductionBoardDto,
  type ProductionBoardEmployeeDto,
  type ProductionBoardPassportRowDto,
  type ProductionBoardQuery,
  type ProductionBoardStageBucketDto,
  type ProductionBoardStageCode,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * «Доска движения тиража» для кабинета мастера.
 *
 * Модель — когорта по дате выдачи кроя (`Passport.cutDate`, UTC-день).
 * Стадии = операции `PRODUCTION_BOARD_STAGES` (источник —
 * `REFERENCE_OPERATIONS`, тот же словарь, что «Экран цеха»). Раскладка
 * паспорта по колонке — по `currentOperation.code`; первый блок строки
 * = сверка `Выдано` (события `ISSUED_TO_EMPLOYEE`) vs `В работе`
 * (паспорта с ≥1 `OPERATION_SCAN`).
 *
 * Read-only: сервис только агрегирует, ничего не мутирует. Контракт —
 * `@sewing/shared` (`packages/shared/src/production-board.ts`).
 *
 * Сознательное упрощение MVP: не реализуем derived `QC_DONE`/`WTO_DONE`
 * (как `ShopfloorService`) — паспорт остаётся в колонке `currentOperation`
 * до следующего скана. Для «где сейчас партия» этого достаточно.
 */
@Injectable()
export class ProductionBoardService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly stageCodes: ProductionBoardStageCode[] =
    PRODUCTION_BOARD_STAGES.map((s) => s.code);

  /** Индекс операции в маршруте доски (для расчёта «не дошло»). */
  private stageIndex(code: string | null | undefined): number {
    if (!code) return -1;
    return this.stageCodes.indexOf(code as ProductionBoardStageCode);
  }

  /** UTC-`YYYY-MM-DD` из Date. */
  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** [from, to] окно по cutDate: последние `days` дней включая сегодня (UTC). */
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

  async getBoard(query: ProductionBoardQuery): Promise<ProductionBoardDto> {
    const { from, to } = this.window(query.days);

    const passports = await this.prisma.passport.findMany({
      where: { cutDate: { gte: from, lte: to } },
      select: {
        id: true,
        cutDate: true,
        qtyCut: true,
        qtyGood: true,
        qtyDefect: true,
        status: true,
        currentEmployeeId: true,
        currentOperation: { select: { code: true } },
        currentEmployee: { select: { id: true, fullName: true } },
        orderId: true,
        order: { select: { number: true, customer: true } },
      },
    });

    // Один групповой запрос на «выдан» (ISSUED_TO_EMPLOYEE) и «в работе»
    // (≥1 OPERATION_SCAN) — те же события, что использует /shopfloor.
    const issuedSet = new Set<string>();
    const inOpsSet = new Set<string>();
    if (passports.length > 0) {
      const ev = await this.prisma.passportEvent.groupBy({
        by: ['passportId', 'type'],
        where: {
          passportId: { in: passports.map((p) => p.id) },
          type: {
            in: [
              PassportEventType.ISSUED_TO_EMPLOYEE,
              PassportEventType.OPERATION_SCAN,
            ],
          },
        },
        _count: { _all: true },
      });
      for (const row of ev) {
        if (row.type === PassportEventType.ISSUED_TO_EMPLOYEE)
          issuedSet.add(row.passportId);
        else if (row.type === PassportEventType.OPERATION_SCAN)
          inOpsSet.add(row.passportId);
      }
    }

    // Когорта = UTC-день cutDate.
    interface Acc {
      cutDate: string;
      orderIds: Set<string>;
      orderLabel: string;
      issuedPassports: number;
      issuedQty: number;
      inOpsPassports: number;
      inOpsQty: number;
      releasedPassports: number;
      releasedQty: number;
      // stageCode -> employeeId -> aggregate
      buckets: Map<
        string,
        Map<
          string,
          {
            employeeId: string | null;
            employeeName: string;
            passports: number;
            qty: number;
            defects: number;
          }
        >
      >;
      // индекс маршрута каждого выданного паспорта (для notReached)
      issuedPositions: number[];
    }

    const NO_EMP = '__none__';
    const cohorts = new Map<string, Acc>();
    const ensure = (key: string, p: (typeof passports)[number]): Acc => {
      let a = cohorts.get(key);
      if (!a) {
        a = {
          cutDate: key,
          orderIds: new Set(),
          orderLabel: '',
          issuedPassports: 0,
          issuedQty: 0,
          inOpsPassports: 0,
          inOpsQty: 0,
          releasedPassports: 0,
          releasedQty: 0,
          buckets: new Map(),
          issuedPositions: [],
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
      const key = this.dayKey(p.cutDate);
      const a = ensure(key, p);
      const isIssued = issuedSet.has(p.id);
      const isInOps = inOpsSet.has(p.id);
      const isPacked = p.status === PassportStatus.PACKED;

      if (isIssued) {
        a.issuedPassports += 1;
        a.issuedQty += p.qtyCut;
        a.issuedPositions.push(
          isPacked
            ? this.stageCodes.length
            : this.stageIndex(p.currentOperation?.code),
        );
      }
      if (isInOps) {
        a.inOpsPassports += 1;
        a.inOpsQty += p.qtyGood;
      }
      if (isPacked) {
        a.releasedPassports += 1;
        a.releasedQty += p.qtyGood;
        continue; // в колонки-стадии PACKED не попадает
      }

      // В колонку-стадию — только живые паспорта на одной из операций доски.
      if (p.status !== PassportStatus.IN_PROGRESS) continue;
      const code = p.currentOperation?.code;
      if (!code || this.stageIndex(code) < 0) continue;

      let byEmp = a.buckets.get(code);
      if (!byEmp) {
        byEmp = new Map();
        a.buckets.set(code, byEmp);
      }
      const empKey = p.currentEmployeeId ?? NO_EMP;
      let agg = byEmp.get(empKey);
      if (!agg) {
        agg = {
          employeeId: p.currentEmployeeId,
          employeeName: p.currentEmployee?.fullName ?? 'Не назначен',
          passports: 0,
          qty: 0,
          defects: 0,
        };
        byEmp.set(empKey, agg);
      }
      agg.passports += 1;
      agg.qty += p.qtyGood;
      agg.defects += p.qtyDefect;
    }

    const cohortDtos: ProductionBoardCohortDto[] = [...cohorts.values()]
      .sort((x, y) => (x.cutDate < y.cutDate ? 1 : -1))
      .map((a) => {
        const stages: ProductionBoardStageBucketDto[] = this.stageCodes.map(
          (code, idx) => {
            const byEmp = a.buckets.get(code);
            const employees: ProductionBoardEmployeeDto[] = byEmp
              ? [...byEmp.values()]
                  .map((e) => ({
                    employeeId: e.employeeId ?? '',
                    employeeName: e.employeeName,
                    passports: e.passports,
                    qty: e.qty,
                    defects: e.defects,
                  }))
                  .sort((m, n) => n.passports - m.passports)
              : [];
            const passportsAt = employees.reduce(
              (s, e) => s + e.passports,
              0,
            );
            const qtyAt = employees.reduce((s, e) => s + e.qty, 0);
            const defectsAt = employees.reduce((s, e) => s + e.defects, 0);
            // «Не дошло» — выданные паспорта, чья позиция в маршруте < idx
            // (ещё не добрались до этой операции). PACKED имеют позицию
            // length → в notReached не попадают.
            const notReached = a.issuedPositions.filter(
              (pos) => pos < idx,
            ).length;
            return {
              code,
              passports: passportsAt,
              qty: qtyAt,
              defects: defectsAt,
              employees,
              notReached,
            };
          },
        );

        const orderLabel =
          a.orderIds.size > 1
            ? `${a.orderIds.size} заказ(ов)`
            : a.orderLabel || '—';

        return {
          cutDate: a.cutDate,
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
      stages: PRODUCTION_BOARD_STAGES.map((s) => ({
        code: s.code,
        label: s.label,
      })),
      cohorts: cohortDtos,
    };
  }

  /** Drill-down: список паспортов когорты на стадии (опц. по сотруднику). */
  async getDrill(
    query: ProductionBoardDrillQuery,
  ): Promise<ProductionBoardDrillDto> {
    const dayStart = new Date(`${query.cutDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${query.cutDate}T23:59:59.999Z`);
    const released = query.stage === PRODUCTION_BOARD_RELEASED;

    const passports = await this.prisma.passport.findMany({
      where: {
        cutDate: { gte: dayStart, lte: dayEnd },
        ...(released
          ? { status: PassportStatus.PACKED }
          : {
              status: PassportStatus.IN_PROGRESS,
              currentOperation: { code: query.stage },
              ...(query.employeeId
                ? { currentEmployeeId: query.employeeId }
                : {}),
            }),
      },
      select: {
        id: true,
        number: true,
        qtyGood: true,
        qtyDefect: true,
        size: { select: { code: true } },
        currentEmployeeId: true,
        currentEmployee: { select: { fullName: true } },
      },
      orderBy: { number: 'asc' },
    });

    const NO_EMP = '__none__';
    const groups = new Map<string, ProductionBoardDrillEmployeeGroupDto>();
    for (const p of passports) {
      const row: ProductionBoardPassportRowDto = {
        passportId: p.id,
        number: p.number,
        sizeCode: p.size?.code ?? '—',
        qty: p.qtyGood,
        defects: p.qtyDefect,
        employeeName: p.currentEmployee?.fullName ?? null,
      };
      const gKey = released ? 'released' : p.currentEmployeeId ?? NO_EMP;
      let g = groups.get(gKey);
      if (!g) {
        g = {
          employeeId: released ? null : p.currentEmployeeId,
          employeeName: released
            ? 'Выпущено (PACKED)'
            : p.currentEmployee?.fullName ?? 'Не назначен',
          passports: 0,
          qty: 0,
          defects: 0,
          rows: [],
        };
        groups.set(gKey, g);
      }
      g.rows.push(row);
      g.passports += 1;
      g.qty += p.qtyGood;
      g.defects += p.qtyDefect;
    }

    const stageLabel = released
      ? 'Выпущено'
      : PRODUCTION_BOARD_STAGES.find((s) => s.code === query.stage)?.label ??
        query.stage;

    const groupList = [...groups.values()].sort(
      (a, b) => b.passports - a.passports,
    );
    return {
      cutDate: query.cutDate,
      stageLabel,
      totalPassports: passports.length,
      totalQty: groupList.reduce((s, g) => s + g.qty, 0),
      totalDefects: groupList.reduce((s, g) => s + g.defects, 0),
      groups: groupList,
    };
  }
}
