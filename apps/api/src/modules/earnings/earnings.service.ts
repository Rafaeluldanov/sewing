import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ApprovalMode,
  EarningSource,
  EntryStatus,
  OperationCategory,
  PayrollPayoutStatus,
  Prisma,
} from '@prisma/client';
import type {
  EarningDto,
  EarningsPage,
  EarningsSummaryDto,
  EarningsSummaryQuery,
  ListEarningsQuery,
} from '@sewing/shared/earnings';
import {
  CUTTER_COMPENSATION_SCHEME_LABELS,
  getCutterCompensationSchemeForDivision,
  type CutterCompensationScheme,
} from '@sewing/shared/cutter-compensation';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OperationsService } from '../operations/operations.service.js';
import { AuditService } from '../audit/audit.service.js';
import { isPieceworkEligible } from '../employees/compensation.js';
import { isEarningsManager } from './earnings.constants.js';

/**
 * Имя ENV-переменной с fallback-процентом B2B-начисления закройщика.
 * Используется, когда у конкретного сотрудника `Employee.
 * cutterB2bSewingPercent IS NULL` — см. recon
 * `docs/payroll-cutter-compensation-recon.md`. Значение читается
 * из `process.env`, нормализуется (запятая/точка, два знака после
 * запятой) и валидируется в `[0; 100]`. Если ENV пустой / битый —
 * возвращается `null` и `EarningsService` тихо пропускает создание
 * B2B-начисления (audit warning «Не задан процент…»).
 */
export const CUTTER_B2B_SEWING_PERCENT_ENV = 'CUTTER_B2B_SEWING_PERCENT';

/**
 * Статусы выплаты, при которых строка начисления считается «выплаченной»
 * и не подлежит пересчёту задним числом (см. `reconcileToQtyGood`,
 * `recomputeCutterForPassport`).
 *
 * `DRAFT` НЕ входит: черновик ещё не выдан, а `PayrollPayoutsService.issue`
 * при проведении перестраивает строки из текущих начислений и подхватит
 * скорректированную сумму. `CANCELLED` — аннулирована, тоже не блокирует.
 * (До фикса учитывалась ЛЮБАЯ `PayrollPayoutLine`, поэтому черновик или
 * отменённая выплата навсегда замораживали устаревшую сумму — и она затем
 * выплачивалась.)
 */
const LOCKED_PAYOUT_STATUSES = [
  PayrollPayoutStatus.ISSUED,
  PayrollPayoutStatus.ACKNOWLEDGED,
] as const;

/**
 * Сервис сдельных начислений (Шаг 9 MVP).
 *
 * Делает три большие вещи:
 *
 * 1. Создаёт `OperationEntry` в нужный момент:
 *    - immediate-начисление раскройщику в `PassportsService.create`
 *      (`createImmediateForCutter`);
 *    - deferred-начисление швее за её только что завершённую
 *      операцию в `PassportsService.completeOperationByEmployee`
 *      (`createPendingForCompletedOperation`).
 *
 * 2. Подтверждает все pending-начисления паспорта в момент закрытия
 *    коробки (`approvePendingForPassport`, вызывается из
 *    `PackingService.close()` после `box.update({ closedAt })` и
 *    проходит по `BoxItem.passportId` в той же транзакции; см.
 *    `docs/events.md §9.6`, `docs/production-flow.md §10.4`/`§11.3`).
 *
 * 3. Отдаёт три read-метода под минимальный API/UI просмотра
 *    (`list`, `summary`, `listByPassport`).
 *
 * Бизнес-правила: ADR-0005, ADR-0012, `docs/flows.md §F2`/`§F4`/`§F7`.
 *
 * Идемпотентность: запись в БД защищена `@@unique` на
 * `(passportId, operationId, employeeId, sourceEventType)`. Сервис
 * дополнительно ловит `P2002` и трактует его как «начисление уже было
 * создано» — повторный скан/повторный create паспорта в той же
 * транзакции не приводит к дублям и не ломается с 500-кой.
 */
@Injectable()
export class EarningsService {
  private readonly logger = new Logger(EarningsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationsService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // CREATE: cutter (immediate)
  // ===========================================================================

  /**
   * Раскройщик: начисление сразу `APPROVED` при выпуске паспорта.
   *
   * Контракт ADR-0005 §«Создание»:
   *   `operationId = CUT_CUT`, `qty = passport.qtyCut`,
   *   `status = APPROVED`, `approvedAt = now()`.
   *
   * Получает ли раскройщик сдельщину — спрашиваем у `isPieceworkEligible`
   * (ADR-0021): `PIECEWORK`/`MIXED` ⇒ да, чистый `SALARY` ⇒ silent skip
   * (на проде раскройщик-сдельщик — норма; кейс с раскройщиком на
   * окладе мы сознательно поддерживаем без падения).
   *
   * Со схемы `B2B cutter compensation` (см.
   * `docs/payroll-cutter-compensation-recon.md`) метод выбирает одну
   * из двух схем по `Order.companyDivision.code`:
   *
   *   - `MARKETPLACE_FIXED` (для `code = MARKETPLACE`): старая схема
   *     `amount = Operation(CUT_CUT).fixedRate × passport.qtyCut`.
   *     Marketplace-flow не меняется ни по `operationId`, ни по
   *     `sourceEventType`, ни по `approvalMode`/`status` — только
   *     продолжаем эту ветку 1-в-1.
   *
   *   - `B2B_SEWING_PERCENT` (для `code = OTHER` и для любого
   *     произвольного `CompanyDivision.code`):
   *     `amount = base × percent / 100`, где
   *     `base = Σ rate(SEWING-операция, размер) × qtyForCompensation`,
   *     `percent = employee.cutterB2bSewingPercent ?? ENV
   *     CUTTER_B2B_SEWING_PERCENT`. `ratePerUnit` для UI считается как
   *     `amount / qtyForCompensation`.
   *
   * Триггер начисления (`PassportsService.create`) и ключ
   * идемпотентности (`@@unique([passportId, operationId, employeeId,
   * sourceEventType])`) сознательно остаются прежними. Повторный
   * trigger приводит к `P2002` и тихому skip в `safeCreate` — даже
   * между двумя схемами начисления.
   *
   * Должен вызываться из той же транзакции, что и
   * `passport.create`, чтобы зарплата и паспорт жили атомарно.
   */
  async createImmediateForCutter(
    tx: Prisma.TransactionClient,
    args: {
      passportId: string;
      cutterId: string;
      sizeId: string;
      productId: string;
      qty: number;
    },
  ): Promise<void> {
    if (args.qty <= 0) return;

    const employee = await tx.employee.findUnique({
      where: { id: args.cutterId },
      select: {
        id: true,
        compensationType: true,
        active: true,
        cutterB2bSewingPercent: true,
      },
    });
    if (!employee || !employee.active) return;
    if (!isPieceworkEligible(employee.compensationType)) return;

    const op = await tx.operation.findUnique({
      where: { code: 'CUT_CUT' },
      select: { id: true, code: true, pricingMode: true },
    });
    if (!op) return;
    // Если раскрой переведён на оклад — никаких сдельных начислений.
    if (op.pricingMode === 'SALARY_ONLY') return;

    // Source of truth для выбора схемы — `passport.order.companyDivision.code`
    // (см. `docs/payroll-cutter-compensation-recon.md §4`,
    // `docs/domain.md §«Подразделения заказа»»). Marketplace
    // (`code = MARKETPLACE`) идёт по фиксированной схеме, всё
    // остальное — через процент от пошива
    // (`B2B_SEWING_PERCENT`-default). Если у заказа `companyDivision`
    // не привязан, helper тоже даёт безопасный B2B-default.
    const passport = await tx.passport.findUnique({
      where: { id: args.passportId },
      select: {
        orderId: true,
        order: {
          select: {
            companyDivision: { select: { code: true } },
          },
        },
      },
    });
    if (!passport) return;
    const divisionCode = passport.order.companyDivision?.code ?? null;
    const scheme = getCutterCompensationSchemeForDivision(divisionCode);

    if (scheme === 'MARKETPLACE_FIXED') {
      await this.createImmediateForCutterMarketplace(tx, {
        passportId: args.passportId,
        orderId: passport.orderId,
        operationId: op.id,
        employeeId: employee.id,
        sizeId: args.sizeId,
        qty: args.qty,
      });
      return;
    }

    await this.createImmediateForCutterB2b(tx, {
      passportId: args.passportId,
      orderId: passport.orderId,
      operationId: op.id,
      employeeId: employee.id,
      employeePercent: employee.cutterB2bSewingPercent,
      sizeId: args.sizeId,
      qty: args.qty,
    });
  }

  /**
   * Marketplace-схема (старая): `amount = Operation.fixedRate × qty`
   * (через `OperationsService.resolveRate`, который умеет и BY_SIZE).
   * Контракт прежний — см. `createImmediateForCutter` JSDoc.
   */
  private async createImmediateForCutterMarketplace(
    tx: Prisma.TransactionClient,
    args: {
      passportId: string;
      orderId: string;
      operationId: string;
      employeeId: string;
      sizeId: string;
      qty: number;
    },
  ): Promise<void> {
    const rate = await this.operations.resolveRate(
      args.operationId,
      args.sizeId,
      tx,
      // Цена раскроя тоже может быть переопределена изделием через
      // snapshot маршрута (`OrderRouteStep.rateOverride`).
      args.orderId,
    );
    if (!rate) return;

    const amount = roundMoney(rate.times(args.qty));
    const created = await this.safeCreate(tx, {
      passportId: args.passportId,
      operationId: args.operationId,
      employeeId: args.employeeId,
      qty: args.qty,
      ratePerUnit: rate,
      amount,
      status: EntryStatus.APPROVED,
      approvalMode: ApprovalMode.IMMEDIATE,
      sourceEventType: EarningSource.PASSPORT_CREATED,
      sourceEventId: null,
      approvedAt: new Date(),
    });

    if (created) {
      // Audit пишем только когда реально создали запись (а не получили
      // P2002 на повторном trigger). Это спасает от шума в журнале при
      // идемпотентных повторных вызовах.
      await this.logCutterAudit(tx, 'MARKETPLACE_FIXED', {
        passportId: args.passportId,
        orderId: args.orderId,
        employeeId: args.employeeId,
        amount: roundMoneyNumber(amount),
        ratePerUnit: roundMoneyNumber(rate),
        qty: args.qty,
      });
    }
  }

  /**
   * B2B-схема: `amount = base × percent / 100`. База берётся из
   * `calculateB2bSewingOperationBaseForPassport` — суммы плановых
   * операций пошива заказа по маршруту. Процент — из
   * `Employee.cutterB2bSewingPercent` или fallback из ENV
   * `CUTTER_B2B_SEWING_PERCENT`. Если процент не задан вообще,
   * начисление сознательно НЕ создаётся (audit warning) — это
   * безопаснее, чем тихо записать 0 ₽ и сбить с толку менеджера.
   */
  private async createImmediateForCutterB2b(
    tx: Prisma.TransactionClient,
    args: {
      passportId: string;
      orderId: string;
      operationId: string;
      employeeId: string;
      employeePercent: Prisma.Decimal | null;
      sizeId: string;
      qty: number;
    },
  ): Promise<void> {
    const percent = this.resolveCutterB2bPercent(args.employeePercent);
    if (!percent) {
      this.logger.warn(
        `event=earnings.cutter.b2b.skip reason=no-percent passportId=${args.passportId} orderId=${args.orderId} employeeId=${args.employeeId}`,
      );
      await this.audit.log(
        {
          event: 'CUTTER_B2B_PERCENT_MISSING',
          entityType: 'PASSPORT',
          entityId: args.passportId,
          employeeId: args.employeeId,
          payload: {
            scheme: 'B2B_SEWING_PERCENT' satisfies CutterCompensationScheme,
            schemeLabel: CUTTER_COMPENSATION_SCHEME_LABELS.B2B_SEWING_PERCENT,
            orderId: args.orderId,
            warning: 'Не задан процент начисления закройщика для B2B',
          },
        },
        tx,
      );
      return;
    }

    const base = await this.calculateB2bSewingOperationBaseForPassport(
      tx,
      args.passportId,
    );
    const baseAmountRub = base.baseAmountRub;
    const qtyForCompensation = base.qtyForCompensation;

    const amount = roundMoney(
      baseAmountRub.times(percent).dividedBy(new Prisma.Decimal(100)),
    );

    if (qtyForCompensation <= 0 || amount.isZero()) {
      // На MVP не создаём «нулевое» начисление — это и для UI
      // прозрачнее («не было начисления» → не было), и не плодит
      // лишних строк. Маршрут не назначен / нет ставок — попадает
      // сюда же; warning'и из base уже в audit.
      this.logger.warn(
        `event=earnings.cutter.b2b.skip reason=zero-amount passportId=${args.passportId} base=${roundMoneyNumber(baseAmountRub)} percent=${percent.toString()} qtyForCompensation=${qtyForCompensation}`,
      );
      await this.audit.log(
        {
          event: 'CUTTER_B2B_AMOUNT_ZERO',
          entityType: 'PASSPORT',
          entityId: args.passportId,
          employeeId: args.employeeId,
          payload: {
            scheme: 'B2B_SEWING_PERCENT' satisfies CutterCompensationScheme,
            schemeLabel: CUTTER_COMPENSATION_SCHEME_LABELS.B2B_SEWING_PERCENT,
            orderId: args.orderId,
            baseAmountRub: roundMoneyNumber(baseAmountRub),
            percent: Number(percent.toFixed(2)),
            qtyForCompensation,
            operationsCount: base.operations.length,
            operations: base.operations.map((o) => ({
              operationId: o.operationId,
              operationCode: o.operationCode,
              operationName: o.operationName,
              pricingMode: o.pricingMode,
              rate: roundMoneyNumber(o.rate),
              qty: o.qty,
              amount: roundMoneyNumber(o.amount),
            })),
            warnings: base.warnings,
          },
        },
        tx,
      );
      return;
    }

    // ratePerUnit = amount / qtyForCompensation. Хранится в
    // `Decimal(12, 2)` — round half-up, как и `amount`.
    const ratePerUnit = roundMoney(
      amount.dividedBy(new Prisma.Decimal(qtyForCompensation)),
    );

    const created = await this.safeCreate(tx, {
      passportId: args.passportId,
      operationId: args.operationId,
      employeeId: args.employeeId,
      // qty в `OperationEntry` оставляем = `passport.qtyCut` (тот же
      // `args.qty`, что приходит снаружи). Это сохраняет UI
      // начислений: «начисление за N единиц». Истинное `qty` для
      // расчёта суммы (qtyForCompensation) для UI не критично —
      // оно фигурирует только в audit-payload.
      qty: args.qty,
      ratePerUnit,
      amount,
      status: EntryStatus.APPROVED,
      approvalMode: ApprovalMode.IMMEDIATE,
      sourceEventType: EarningSource.PASSPORT_CREATED,
      sourceEventId: null,
      approvedAt: new Date(),
    });

    if (created) {
      await this.logCutterAudit(tx, 'B2B_SEWING_PERCENT', {
        passportId: args.passportId,
        orderId: args.orderId,
        employeeId: args.employeeId,
        amount: roundMoneyNumber(amount),
        ratePerUnit: roundMoneyNumber(ratePerUnit),
        qty: args.qty,
        baseAmountRub: roundMoneyNumber(baseAmountRub),
        percent: Number(percent.toFixed(2)),
        qtyForCompensation,
        operationsCount: base.operations.length,
        operations: base.operations.map((o) => ({
          operationId: o.operationId,
          operationCode: o.operationCode,
          operationName: o.operationName,
          pricingMode: o.pricingMode,
          rate: roundMoneyNumber(o.rate),
          qty: o.qty,
          amount: roundMoneyNumber(o.amount),
        })),
        warnings: base.warnings,
      });
    }
  }

  /**
   * Резолвит процент B2B-начисления для конкретного сотрудника.
   * Приоритет:
   *
   *   1. `Employee.cutterB2bSewingPercent` (если задан и валиден);
   *   2. ENV `CUTTER_B2B_SEWING_PERCENT` (string, normalize запятой,
   *      валидируется в `[0; 100]`);
   *   3. `null` — процент не задан, B2B-начисление не создаётся.
   *
   * Если значение из БД или ENV вне диапазона `(0; 100]` — возвращаем
   * `null` (тот же эффект «не задан»). 0 % трактуем как «не задано» —
   * нет смысла создавать начисление на 0 ₽.
   */
  private resolveCutterB2bPercent(
    employeePercent: Prisma.Decimal | null,
  ): Prisma.Decimal | null {
    if (employeePercent !== null && employeePercent !== undefined) {
      const num = Number(employeePercent);
      if (Number.isFinite(num) && num > 0 && num <= 100) {
        return new Prisma.Decimal(num.toFixed(2));
      }
    }

    const raw = process.env[CUTTER_B2B_SEWING_PERCENT_ENV];
    if (!raw) return null;
    const normalized = raw.trim().replace(',', '.');
    if (normalized === '') return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      this.logger.warn(
        `event=earnings.cutter.b2b.env_invalid env=${CUTTER_B2B_SEWING_PERCENT_ENV} value=${raw}`,
      );
      return null;
    }
    return new Prisma.Decimal(parsed.toFixed(2));
  }

  /**
   * Запись audit-события успешного создания cutter-начисления.
   * Вынесено в helper, чтобы оба пути (marketplace / b2b) писали
   * единый формат payload (`scheme`, `schemeLabel`, `amount`,
   * `ratePerUnit`, `qty`) и расширения шли в одном месте.
   */
  private async logCutterAudit(
    tx: Prisma.TransactionClient,
    scheme: CutterCompensationScheme,
    payload: {
      passportId: string;
      orderId: string;
      employeeId: string;
      amount: number;
      ratePerUnit: number;
      qty: number;
      // Дополнительные поля для B2B (необязательные):
      baseAmountRub?: number;
      percent?: number;
      qtyForCompensation?: number;
      operationsCount?: number;
      operations?: Array<Record<string, unknown>>;
      warnings?: string[];
    },
  ): Promise<void> {
    // `Prisma.InputJsonValue` не пропускает `undefined`, поэтому
    // собираем payload без spread-а опциональных полей и аккуратно
    // выкидываем `undefined`.
    const auditPayload: Record<string, unknown> = {
      scheme,
      schemeLabel: CUTTER_COMPENSATION_SCHEME_LABELS[scheme],
      orderId: payload.orderId,
      amount: payload.amount,
      ratePerUnit: payload.ratePerUnit,
      qty: payload.qty,
    };
    if (payload.baseAmountRub !== undefined) {
      auditPayload.baseAmountRub = payload.baseAmountRub;
    }
    if (payload.percent !== undefined) {
      auditPayload.percent = payload.percent;
    }
    if (payload.qtyForCompensation !== undefined) {
      auditPayload.qtyForCompensation = payload.qtyForCompensation;
    }
    if (payload.operationsCount !== undefined) {
      auditPayload.operationsCount = payload.operationsCount;
    }
    if (payload.operations !== undefined) {
      auditPayload.operations = payload.operations;
    }
    if (payload.warnings !== undefined) {
      auditPayload.warnings = payload.warnings;
    }

    await this.audit.log(
      {
        event: 'CUTTER_EARNING_CREATED',
        entityType: 'PASSPORT',
        entityId: payload.passportId,
        employeeId: payload.employeeId,
        payload: auditPayload as Prisma.InputJsonValue,
      },
      tx,
    );
  }

  // ===========================================================================
  // CREATE: cutter (b2b base helper)
  // ===========================================================================

  /**
   * Считает плановую сумму операций пошива по маршруту заказа для
   * конкретного паспорта (см. `docs/payroll-cutter-compensation-recon.md
   * §6 «Контракт нового метода»`). Используется как `base` в B2B-схеме
   * начисления закройщика.
   *
   * Алгоритм:
   *
   *   1. Загружает паспорт + snapshot маршрута заказа
   *      (`Order.routeSteps[].operation`) и фильтрует шаги по
   *      `Operation.category = SEWING`.
   *   2. `qtyForCompensation = passport.qtyCut > 0 ? passport.qtyCut :
   *      passport.qtyPlan` (на момент создания паспорта совпадают,
   *      но в будущих повторных trigger'ах qtyCut может уже быть
   *      зафиксирован).
   *   3. Для каждой швейной операции резолвит ставку по `pricingMode`:
   *      - `FIXED` — `Operation.fixedRate`;
   *      - `BY_SIZE` — `OperationRateBySize` для `passport.sizeId`;
   *      - `SALARY_ONLY` — пропускает (не попадает в base).
   *   4. Складывает `Σ rate × qtyForCompensation`. Результат
   *      округляется до 2 знаков.
   *
   * Если ставка отсутствует (нет `OperationRateBySize` для размера,
   * `FIXED` без `fixedRate`, etc.) — операция в base не попадает,
   * добавляется warning. Workflow не падает.
   *
   * Метод сделан `public`, чтобы его можно было дёргать из тестов
   * напрямую и из будущих audit-команд (например, «покажи мне base
   * для этого паспорта без создания начисления»).
   */
  async calculateB2bSewingOperationBaseForPassport(
    tx: Prisma.TransactionClient,
    passportId: string,
  ): Promise<{
    baseAmountRub: Prisma.Decimal;
    qtyForCompensation: number;
    operations: Array<{
      operationId: string;
      operationCode: string;
      operationName: string;
      pricingMode: string;
      rate: Prisma.Decimal;
      qty: number;
      amount: Prisma.Decimal;
    }>;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const passport = await tx.passport.findUnique({
      where: { id: passportId },
      select: {
        id: true,
        orderId: true,
        sizeId: true,
        qtyPlan: true,
        qtyCut: true,
        order: {
          select: {
            id: true,
            companyDivision: { select: { code: true } },
            routeSteps: {
              select: {
                index: true,
                operationId: true,
                rateOverride: true,
                pricingModeOverride: true,
                operation: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    category: true,
                    pricingMode: true,
                    fixedRate: true,
                  },
                },
              },
              orderBy: { index: 'asc' },
            },
          },
        },
      },
    });
    if (!passport) {
      // Это «не должно случиться» в нормальном вызове из
      // `createImmediateForCutter`, но возвращаем безопасный пустой
      // результат, чтобы вызывающий код не упал.
      warnings.push('Паспорт не найден');
      return {
        baseAmountRub: new Prisma.Decimal(0),
        qtyForCompensation: 0,
        operations: [],
        warnings,
      };
    }

    const qtyForCompensation =
      passport.qtyCut > 0 ? passport.qtyCut : passport.qtyPlan;
    if (qtyForCompensation <= 0) {
      warnings.push('qtyForCompensation = 0, base не считается');
      return {
        baseAmountRub: new Prisma.Decimal(0),
        qtyForCompensation: 0,
        operations: [],
        warnings,
      };
    }

    const sewingSteps = passport.order.routeSteps.filter(
      (s) => s.operation.category === OperationCategory.SEWING,
    );
    if (sewingSteps.length === 0) {
      warnings.push(
        'У заказа нет операций категории SEWING (или маршрут не назначен)',
      );
      return {
        baseAmountRub: new Prisma.Decimal(0),
        qtyForCompensation,
        operations: [],
        warnings,
      };
    }

    const operations: Array<{
      operationId: string;
      operationCode: string;
      operationName: string;
      pricingMode: string;
      rate: Prisma.Decimal;
      qty: number;
      amount: Prisma.Decimal;
    }> = [];
    let baseAmountRub = new Prisma.Decimal(0);

    for (const step of sewingSteps) {
      const op = step.operation;
      // Эффективный способ оплаты: переопределение заказа (оклад ⇄
      // сделка) вытесняет дефолт операции. Та же логика, что в
      // `OperationsService.resolveRate`.
      const mode = step.pricingModeOverride ?? op.pricingMode;
      // SALARY_ONLY-операции в base не попадают (они не дают
      // деньги швеям и не должны давать B2B-base закройщику).
      if (mode === 'SALARY_ONLY') {
        warnings.push(
          `Операция ${op.code}: pricingMode = SALARY_ONLY, не учитывается в B2B base`,
        );
        continue;
      }

      let rate: Prisma.Decimal | null = null;
      if (mode === 'FIXED') {
        // Переопределение изделием (snapshot маршрута) вытесняет дефолт
        // операции — та же логика, что в `OperationsService.resolveRate`.
        const effectiveRate = step.rateOverride ?? op.fixedRate;
        if (effectiveRate === null || effectiveRate === undefined) {
          warnings.push(
            `Операция ${op.code}: FIXED без fixedRate, пропущена`,
          );
          continue;
        }
        rate = effectiveRate;
      } else if (mode === 'BY_SIZE') {
        // Поразмерное переопределение расценки внутри заказа (snapshot
        // маршрута) вытесняет дефолт `OperationRateBySize`; та же логика,
        // что в `OperationsService.resolveRate`. Справочник не трогается.
        const override = await tx.orderRouteStepSizeOverride.findFirst({
          where: {
            sizeId: passport.sizeId,
            rate: { not: null },
            routeStep: { orderId: passport.orderId, operationId: op.id },
          },
          select: { rate: true },
        });
        let bySizeRate = override?.rate ?? null;
        if (bySizeRate == null) {
          const row = await tx.operationRateBySize.findUnique({
            where: {
              OperationRateBySize_operation_size_uniq: {
                operationId: op.id,
                sizeId: passport.sizeId,
              },
            },
            select: { rate: true },
          });
          if (!row) {
            warnings.push(
              `Операция ${op.code}: BY_SIZE без ставки для размера паспорта, пропущена`,
            );
            continue;
          }
          bySizeRate = row.rate;
        }
        rate = bySizeRate;
      } else {
        // Неизвестный pricingMode — на будущее. Не падаем.
        warnings.push(
          `Операция ${op.code}: неизвестный pricingMode ${op.pricingMode}, пропущена`,
        );
        continue;
      }

      const amount = roundMoney(rate.times(qtyForCompensation));
      operations.push({
        operationId: op.id,
        operationCode: op.code,
        operationName: op.name,
        pricingMode: mode,
        rate,
        qty: qtyForCompensation,
        amount,
      });
      baseAmountRub = baseAmountRub.plus(amount);
    }

    return {
      baseAmountRub: roundMoney(baseAmountRub),
      qtyForCompensation,
      operations,
      warnings,
    };
  }

  // ===========================================================================
  // CREATE: sewing (after release)
  // ===========================================================================

  /**
   * Пошив: в момент, когда швея явно завершила свою операцию через
   * `PassportsService.completeOperationByEmployee`, создаём ей
   * `PENDING_RELEASE`-начисление за эту операцию. Контракт ADR-0005
   * §«Создание»: `status = PENDING_RELEASE`, `approvedAt = null`,
   * `qty = passport.qtyCut`. Подтверждение по-прежнему — на закрытии
   * коробки (`approvePendingForPassport`).
   *
   * Источник истины «есть ли сдельная ставка» — `Operation.pricingMode`
   * (см. `docs/domain.md §16a`, `OperationsService.resolveRate`). Если
   * операция оклад/нет ставки или исполнитель не piecework — тихо
   * ничего не создаём.
   *
   * Дубли защищены `@@unique`: повторный complete тем же сотрудником
   * по тому же паспорту/операции не поднимает второе начисление.
   *
   * Должен вызываться из той же транзакции, что и `OPERATION_FINISHED`
   * `PassportEvent` и обновление `Passport.currentOperationId`.
   */
  async createPendingForCompletedOperation(
    tx: Prisma.TransactionClient,
    args: {
      passportId: string;
      operationId: string | null;
      employeeId: string | null;
      productId: string;
      sizeId: string;
      qty: number;
      sourceEventId?: string | null;
      /**
       * Создать сразу `APPROVED` (а не `PENDING_RELEASE`). Нужен для
       * retroactive-веток ВТО/ОТК на паспортах в статусе `PACKED`:
       * закрытие коробки уже было, второго `approvePendingForPassport`
       * не случится — иначе строка зависнет в pending навсегда.
       */
      approveImmediately?: boolean;
      /**
       * Номер прохода операции по маршруту (`OperationEntry.passOrdinal`),
       * если вызывающий знает его точнее позиции паспорта. Нужен ОТК:
       * `QC_PASSED` не двигает `currentRouteStepIndex`, поэтому вторая
       * проверка в маршруте определяется по числу пройденных проверок.
       */
      passOrdinal?: number;
    },
  ): Promise<void> {
    if (!args.operationId || !args.employeeId) return;
    if (args.qty <= 0) return;

    const op = await tx.operation.findUnique({
      where: { id: args.operationId },
      select: { id: true, code: true, pricingMode: true },
    });
    if (!op) return;
    // Источник истины — Operation.pricingMode (см. ADR-0005,
    // `docs/domain.md §16a`):
    //   SALARY_ONLY → нет сдельной ставки, ничего не создаём;
    //   FIXED / BY_SIZE → создаём начисление по resolveRate.
    if (op.pricingMode === 'SALARY_ONLY') return;
    // CUT_CUT покрывается immediate-веткой при выпуске паспорта
    // (`createImmediateForCutter`), здесь — только пошив.
    if (op.code === 'CUT_CUT') return;

    const employee = await tx.employee.findUnique({
      where: { id: args.employeeId },
      select: { id: true, compensationType: true, active: true },
    });
    if (!employee || !employee.active) return;
    if (!isPieceworkEligible(employee.compensationType)) return;

    // orderId нужен, чтобы resolveRate подхватил переопределённую
    // изделием расценку (`OrderRouteStep.rateOverride`) для FIXED-операций.
    const passportForOrder = await tx.passport.findUnique({
      where: { id: args.passportId },
      select: { orderId: true, currentRouteStepIndex: true },
    });
    const passOrdinal =
      args.passOrdinal ??
      (await this.resolvePassOrdinal(tx, {
        orderId: passportForOrder?.orderId ?? null,
        operationId: op.id,
        currentRouteStepIndex: passportForOrder?.currentRouteStepIndex ?? null,
      }));
    const rate = await this.operations.resolveRate(
      op.id,
      args.sizeId,
      tx,
      passportForOrder?.orderId ?? null,
    );
    if (!rate) return;

    const baseAmount = roundMoney(rate.times(args.qty));

    // Substitute credit (см. `OperationSubstitution`, миграция
    // `20260729200000_add_operation_substitution`).
    //
    // Сценарий: швея сначала закрыла «Распошив рукав» (16) с
    // OperationEntry на 10/шт, потом сломался Подгиб низа, она
    // добивает то же на тех же паспортах и закрывает «РАСПОШИВ» (04,
    // ставка 20). 04 — substitute для 16 и 0001, поэтому здесь не
    // должно быть двойной оплаты: вычитаем уже выплаченное по
    // satisfied-операциям ЭТОМУ ЖЕ сотруднику на ЭТОМ ЖЕ паспорте.
    //
    // Уже существующие APPROVED/PENDING_RELEASE по satisfied-ops
    // вычитаются из baseAmount. Если итог ≤ 0 — начисление не создаём
    // вовсе (полностью покрыто substitute'ом предыдущих ops). Минусовых
    // OperationEntry не пишем — это «корректировка», а не реверс.
    const substituted = await tx.operationSubstitution.findMany({
      where: { substituteOpId: op.id },
      select: { satisfiesOpId: true },
    });
    let creditedAmount = baseAmount;
    let creditedAgainst: { operationId: string; amount: string }[] = [];
    if (substituted.length > 0) {
      const prior = await tx.operationEntry.findMany({
        where: {
          passportId: args.passportId,
          employeeId: employee.id,
          operationId: { in: substituted.map((s) => s.satisfiesOpId) },
          status: { in: [EntryStatus.APPROVED, EntryStatus.PENDING_RELEASE] },
        },
        select: { id: true, operationId: true, amount: true },
      });
      const priorSum = prior.reduce(
        (acc, p) => acc.plus(p.amount),
        baseAmount.minus(baseAmount), // нулевой Decimal того же типа
      );
      creditedAmount = roundMoney(baseAmount.minus(priorSum));
      creditedAgainst = prior.map((p) => ({
        operationId: p.operationId,
        amount: p.amount.toString(),
      }));
      if (creditedAmount.lte(0)) {
        // Полностью покрыто — ничего не создаём, но логируем для аудита.
        this.logger.log(
          `event=earnings.substitute.fullyCovered passportId=${args.passportId} employeeId=${employee.id} substituteOp=${op.id} baseAmount=${baseAmount.toString()} priorSum=${priorSum.toString()}`,
        );
        return;
      }
    }

    const approveImmediately = args.approveImmediately === true;
    await this.safeCreate(tx, {
      passportId: args.passportId,
      operationId: op.id,
      employeeId: employee.id,
      qty: args.qty,
      ratePerUnit: rate,
      amount: creditedAmount,
      status: approveImmediately
        ? EntryStatus.APPROVED
        : EntryStatus.PENDING_RELEASE,
      approvalMode: ApprovalMode.AFTER_RELEASE,
      sourceEventType: EarningSource.OPERATION_TRANSITION,
      sourceEventId: args.sourceEventId ?? null,
      passOrdinal,
      approvedAt: approveImmediately ? new Date() : null,
    });
    if (creditedAgainst.length > 0) {
      this.logger.log(
        `event=earnings.substitute.credited passportId=${args.passportId} employeeId=${employee.id} substituteOp=${op.id} baseAmount=${baseAmount.toString()} creditedAmount=${creditedAmount.toString()} against=${JSON.stringify(creditedAgainst)}`,
      );
    }
  }

  // ===========================================================================
  // APPROVE: after packing
  // ===========================================================================

  /**
   * Подтверждение всех висящих pending-начислений паспорта в момент
   * упаковки. Ровно один SQL-update в общей транзакции.
   *
   * Возвращает количество затронутых записей — удобно для логирования
   * и тестов, но в самом `PackingService` не обязательно.
   */
  async approvePendingForPassport(
    tx: Prisma.TransactionClient,
    passportId: string,
    approvedAt: Date = new Date(),
  ): Promise<number> {
    const result = await tx.operationEntry.updateMany({
      where: {
        passportId,
        status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
      },
      data: {
        status: EntryStatus.APPROVED,
        approvedAt,
      },
    });
    return result.count;
  }

  // ===========================================================================
  // REVOKE: rework по браку
  // ===========================================================================

  /**
   * Отозвать pending-начисления за конкретную операцию по паспорту.
   *
   * Сценарий: ОТК вернул паспорт на переделку (см.
   * `QcService.returnToRework`, `docs/flows.md §F5a`). Результат
   * предыдущего прохода отбракован — pending-начисление швеи, что
   * сделала тот проход, должно быть отозвано, чтобы выполнялся
   * инвариант «оплата за изделие — один раз». После переделки новый
   * `OPERATION_FINISHED` создаст начисление финишёру финального
   * успешного прохода.
   *
   * Безопасность: трогаем только `PENDING_RELEASE` (pending до
   * упаковки). `APPROVED` не трогаем — деньги уже подтверждены при
   * `PackingService.close`, до этой точки rework невозможен (packing
   * требует QC_PASSED, который как раз и проходит ровно перед
   * упаковкой). На случай рассинхрона `APPROVED` останется как есть —
   * сервис вернёт count удалённых и залогирует расхождение, если оно
   * вдруг случится.
   *
   * Идемпотентно: повторный rework по той же (passport, operation)
   * просто удалит 0 строк (предыдущие уже удалены).
   */
  async revokePendingForOperation(
    tx: Prisma.TransactionClient,
    passportId: string,
    operationId: string,
  ): Promise<number> {
    const result = await tx.operationEntry.deleteMany({
      where: {
        passportId,
        operationId,
        status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
      },
    });
    return result.count;
  }

  // ===========================================================================
  // RECONCILE: после изменения Passport.qtyGood
  // ===========================================================================

  /**
   * Привести `OperationEntry.qty` всех сдельных начислений по паспорту к
   * актуальному `qtyGood`. Сценарии:
   *   - ОТК зафиксировал брак уже после того, как швеи/ВТО закрыли свои
   *     операции (`qtyGood` уменьшился) — начисления гасим вниз;
   *   - мастер подтвердил корректировку количества «в плюс»
   *     (`qtyGood` вырос, см. `PassportQtyCorrectionsService`) — тогда
   *     начисления надо поднять обратно к новому `qtyGood`.
   * `OperationEntry` хранят `qty` снимком на момент завершения операции
   * и сами не пересчитываются — поэтому метод двунаправленный: приводит
   * любую строку с `qty != qtyGood` к `qtyGood` (кроме исключений ниже).
   *
   * Cutter (`sourceEventType = PASSPORT_CREATED`) сознательно не трогаем —
   * раскройщик платится за `qtyCut`, его пересчитывает отдельный
   * `recomputeCutterForPassport` (когда корректировка двигает и раскрой).
   *
   * Строки в ВЫДАННОЙ выплате (`LOCKED_PAYOUT_STATUSES` = ISSUED/
   * ACKNOWLEDGED) пропускаем — менять сумму задним числом по выданному
   * документу нельзя; они возвращаются в `skipped[]` для разбора
   * менеджером. Черновик (DRAFT) НЕ блокирует: при проведении `issue`
   * перестроит строки из текущих начислений.
   *
   * Замещающие операции (`OperationSubstitution`) пересчитываются вторым
   * проходом с сохранением кредита (`rate×qtyGood − Σ satisfied`), иначе
   * «в лоб» `rate×qtyGood` затёр бы кредит и переплатил.
   */
  async reconcileToQtyGood(
    tx: Prisma.TransactionClient,
    passportId: string,
  ): Promise<{
    updated: number;
    skipped: Array<{ id: string; reason: 'ALREADY_PAID' }>;
  }> {
    const passport = await tx.passport.findUnique({
      where: { id: passportId },
      select: { qtyGood: true },
    });
    if (!passport) return { updated: 0, skipped: [] };

    const qtyGood = passport.qtyGood;

    const candidates = await tx.operationEntry.findMany({
      where: {
        passportId,
        sourceEventType: { not: EarningSource.PASSPORT_CREATED },
        // Двунаправленно: любая строка, чей снимок разошёлся с текущим
        // qtyGood (и вниз при браке, и вверх при корректировке «в плюс»).
        qty: { not: qtyGood },
      },
      select: {
        id: true,
        ratePerUnit: true,
        operationId: true,
        employeeId: true,
      },
    });
    if (candidates.length === 0) return { updated: 0, skipped: [] };

    // «Уже выплачено» = строка попала в ВЫДАННУЮ выплату (ISSUED/
    // ACKNOWLEDGED). Черновик/отменённую не считаем блокирующими —
    // см. `LOCKED_PAYOUT_STATUSES`.
    const paid = await tx.payrollPayoutLine.findMany({
      where: {
        operationEntryId: { in: candidates.map((c) => c.id) },
        payout: { status: { in: [...LOCKED_PAYOUT_STATUSES] } },
      },
      select: { operationEntryId: true },
    });
    const paidIds = new Set(
      paid.map((p) => p.operationEntryId).filter((x): x is string => !!x),
    );

    // Замещающие операции (`OperationSubstitution`): у них `amount` — это
    // КРЕДИТ (`rate×qty − Σ уже оплаченных satisfied-операций`), а не
    // `rate×qty` (см. `createPendingForCompletedOperation`). Пересчёт «в
    // лоб» `rate×qtyGood` затирал бы кредит и переплачивал, поэтому такие
    // строки считаем ВТОРЫМ проходом — после того как обычные (в т.ч.
    // satisfied) приведены к qtyGood — и пересчитываем кредит по их свежим
    // суммам тем же способом, что и create-путь.
    const substitutionRows = await tx.operationSubstitution.findMany({
      where: { substituteOpId: { in: candidates.map((c) => c.operationId) } },
      select: { substituteOpId: true, satisfiesOpId: true },
    });
    const satisfiesBySubOp = new Map<string, string[]>();
    for (const r of substitutionRows) {
      const arr = satisfiesBySubOp.get(r.substituteOpId) ?? [];
      arr.push(r.satisfiesOpId);
      satisfiesBySubOp.set(r.substituteOpId, arr);
    }

    const zero = new Prisma.Decimal(0);
    const skipped: Array<{ id: string; reason: 'ALREADY_PAID' }> = [];
    let updated = 0;

    const reconcileRegular = async (c: (typeof candidates)[number]) => {
      await tx.operationEntry.update({
        where: { id: c.id },
        data: { qty: qtyGood, amount: roundMoney(c.ratePerUnit.times(qtyGood)) },
      });
    };
    const reconcileSubstitute = async (c: (typeof candidates)[number]) => {
      const baseAmount = roundMoney(c.ratePerUnit.times(qtyGood));
      // Свежие суммы satisfied-операций того же сотрудника на этом
      // паспорте (те же статусы, что учитывает create-путь).
      const prior = await tx.operationEntry.findMany({
        where: {
          passportId,
          employeeId: c.employeeId,
          operationId: { in: satisfiesBySubOp.get(c.operationId) ?? [] },
          status: { in: [EntryStatus.APPROVED, EntryStatus.PENDING_RELEASE] },
        },
        select: { amount: true },
      });
      const priorSum = prior.reduce((acc, p) => acc.plus(p.amount), zero);
      const credited = roundMoney(baseAmount.minus(priorSum));
      await tx.operationEntry.update({
        where: { id: c.id },
        // Кредит не может быть отрицательным: если satisfied-операции
        // полностью покрыли базу — вклад замещающей строки = 0.
        data: { qty: qtyGood, amount: credited.lte(0) ? zero : credited },
      });
    };

    // 1-й проход — обычные и satisfied-строки (даёт свежий priorSum для 2-го).
    // 2-й проход — замещающие, по уже пересчитанным satisfied-суммам.
    for (const c of candidates) {
      if (satisfiesBySubOp.has(c.operationId)) continue;
      if (paidIds.has(c.id)) {
        skipped.push({ id: c.id, reason: 'ALREADY_PAID' });
        continue;
      }
      await reconcileRegular(c);
      updated += 1;
    }
    for (const c of candidates) {
      if (!satisfiesBySubOp.has(c.operationId)) continue;
      if (paidIds.has(c.id)) {
        skipped.push({ id: c.id, reason: 'ALREADY_PAID' });
        continue;
      }
      await reconcileSubstitute(c);
      updated += 1;
    }
    return { updated, skipped };
  }

  /**
   * Пересчитать immediate-начисление раскройщика по актуальному
   * `Passport.qtyCut`. Нужно, когда корректировка количества двигает и
   * раскрой (см. `PassportQtyCorrectionsService.approve`): раскройщик
   * платится за `qtyCut`, поэтому `reconcileToQtyGood` его не трогает.
   *
   * Механика — та же delete-and-recreate, что в `PassportsService.update`
   * на статусе `CREATED`: сносим старые `PASSPORT_CREATED`-строки и
   * создаём заново через `createImmediateForCutter` (он сам выберет
   * схему MARKETPLACE_FIXED / B2B_SEWING_PERCENT по новому `qtyCut`).
   *
   * Уже выплаченную строку (в `PayrollPayoutLine`) не трогаем: менять
   * закрытый выплатной документ задним числом нельзя — возвращаем её в
   * `skipped` для ручного разбора менеджером.
   */
  async recomputeCutterForPassport(
    tx: Prisma.TransactionClient,
    passportId: string,
  ): Promise<{ updated: number; skipped: number }> {
    const passport = await tx.passport.findUnique({
      where: { id: passportId },
      select: { cutterId: true, sizeId: true, productId: true, qtyCut: true },
    });
    if (!passport) return { updated: 0, skipped: 0 };

    const cutterEntries = await tx.operationEntry.findMany({
      where: { passportId, sourceEventType: EarningSource.PASSPORT_CREATED },
      select: { id: true },
    });

    if (cutterEntries.length > 0) {
      const paid = await tx.payrollPayoutLine.findMany({
        where: {
          operationEntryId: { in: cutterEntries.map((c) => c.id) },
          payout: { status: { in: [...LOCKED_PAYOUT_STATUSES] } },
        },
        select: { operationEntryId: true },
      });
      if (paid.length > 0) {
        // Хотя бы одна строка раскройщика уже в ВЫДАННОЙ выплате (ISSUED/
        // ACKNOWLEDGED) — не переписываем её задним числом. Черновик не
        // блокирует: issue перестроит строки при проведении.
        return { updated: 0, skipped: cutterEntries.length };
      }
      await tx.operationEntry.deleteMany({
        where: { passportId, sourceEventType: EarningSource.PASSPORT_CREATED },
      });
    }

    await this.createImmediateForCutter(tx, {
      passportId,
      cutterId: passport.cutterId,
      sizeId: passport.sizeId,
      productId: passport.productId,
      qty: passport.qtyCut,
    });

    return { updated: cutterEntries.length, skipped: 0 };
  }

  // ===========================================================================
  // READ: list
  // ===========================================================================

  /**
   * Списочное чтение начислений с RBAC-скоупом.
   *
   * Менеджерские роли (`SHOP_MANAGER`, `ADMIN`, см.
   * `EARNINGS_MANAGER_ROLES`) видят все строки и могут фильтровать по
   * любому `employeeId`/`status` из query. Все остальные роли получают
   * принудительный скоуп: `employeeId = viewer.employeeId` и
   * `status = APPROVED`. Любой query-параметр, которым обычный
   * пользователь пытается посмотреть чужие строки или pending —
   * затирается на сервере.
   *
   * См. `docs/api.md §10`, ADR-0014 §«Сотрудник всегда из сессии».
   */
  async list(
    query: ListEarningsQuery,
    viewer: AuthPrincipal,
  ): Promise<EarningsPage> {
    const scoped = this.applyViewerScopeToList(query, viewer);
    const where = this.buildWhere(scoped);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.operationEntry.count({ where }),
      this.prisma.operationEntry.findMany({
        where,
        include: this.detailInclude(),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (scoped.page - 1) * scoped.pageSize,
        take: scoped.pageSize,
      }),
    ]);

    return {
      items: rows.map((r) => this.toDto(r)),
      total,
      page: scoped.page,
      pageSize: scoped.pageSize,
    };
  }

  // ===========================================================================
  // READ: summary
  // ===========================================================================

  async summary(
    query: EarningsSummaryQuery,
    viewer: AuthPrincipal,
  ): Promise<EarningsSummaryDto> {
    const isManager = isEarningsManager(viewer.role);
    const baseWhere: Prisma.OperationEntryWhereInput = {};
    // Не-менеджер всегда видит только свои строки. employeeId из query
    // игнорируется (см. ADR-0014 §«Сотрудник всегда из сессии»).
    if (!isManager) {
      baseWhere.employeeId = viewer.employeeId;
    } else if (query.employeeId) {
      baseWhere.employeeId = query.employeeId;
    }
    if (query.dateFrom || query.dateTo) {
      baseWhere.createdAt = {};
      if (query.dateFrom) baseWhere.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) baseWhere.createdAt.lte = new Date(query.dateTo);
    }

    if (!isManager) {
      // Обычный сотрудник не видит pending → нет смысла агрегировать
      // их и нет шанса «случайно» отдать сумму неподтверждённых.
      const approved = await this.prisma.operationEntry.aggregate({
        where: { ...baseWhere, status: EntryStatus.APPROVED },
        _sum: { amount: true },
        _count: { _all: true },
      });
      return {
        totalApproved: roundMoneyNumber(approved._sum.amount),
        totalPending: 0,
        countApproved: approved._count._all,
        countPending: 0,
      };
    }

    // Считаем pending как PENDING_RELEASE + legacy PENDING (на случай
    // ранее созданных строк): это снимает риск «пропавших копеек» при
    // переходе со старой схемы на новую.
    const [approved, pending] = await this.prisma.$transaction([
      this.prisma.operationEntry.aggregate({
        where: { ...baseWhere, status: EntryStatus.APPROVED },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.operationEntry.aggregate({
        where: {
          ...baseWhere,
          status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    return {
      totalApproved: roundMoneyNumber(approved._sum.amount),
      totalPending: roundMoneyNumber(pending._sum.amount),
      countApproved: approved._count._all,
      countPending: pending._count._all,
    };
  }

  // ===========================================================================
  // READ: by passport
  // ===========================================================================

  async listByPassport(
    passportId: string,
    viewer: AuthPrincipal,
  ): Promise<EarningDto[]> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: { id: true },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    const where: Prisma.OperationEntryWhereInput = { passportId };
    if (!isEarningsManager(viewer.role)) {
      // Обычный сотрудник по паспорту видит только свои подтверждённые
      // начисления. Если их нет — отдаём пустой список, не подсвечивая
      // факт чужих pending/approved строк по этому паспорту.
      where.employeeId = viewer.employeeId;
      where.status = EntryStatus.APPROVED;
    }
    const rows = await this.prisma.operationEntry.findMany({
      where,
      include: this.detailInclude(),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  /**
   * Накладывает RBAC-скоуп на query для `/api/earnings`. Для не-менеджера
   * затирает `employeeId` на свой и фиксирует `status = APPROVED`,
   * игнорируя любые попытки обойти ограничение через query-string.
   */
  private applyViewerScopeToList(
    query: ListEarningsQuery,
    viewer: AuthPrincipal,
  ): ListEarningsQuery {
    if (isEarningsManager(viewer.role)) return query;
    return {
      ...query,
      employeeId: viewer.employeeId,
      status: 'APPROVED',
    };
  }

  private buildWhere(query: ListEarningsQuery): Prisma.OperationEntryWhereInput {
    const where: Prisma.OperationEntryWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.passportId) where.passportId = query.passportId;
    if (query.status) {
      // На MVP принимаем PENDING_RELEASE как фильтр; PENDING как legacy
      // подтягиваем через OR, чтобы старые тестовые данные не «исчезали»
      // из списка при выборе фильтра «PENDING_RELEASE».
      if (query.status === 'PENDING_RELEASE') {
        where.status = {
          in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING],
        };
      } else {
        where.status = EntryStatus[query.status];
      }
    }
    if (query.approvalMode) where.approvalMode = ApprovalMode[query.approvalMode];
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }
    return where;
  }

  private detailInclude() {
    return {
      passport: {
        include: {
          order: { select: { id: true, number: true } },
          product: { select: { name: true } },
          size: true,
        },
      },
      operation: { select: { id: true, code: true, name: true } },
      employee: { select: { id: true, fullName: true } },
    } satisfies Prisma.OperationEntryInclude;
  }

  private toDto(
    row: Prisma.OperationEntryGetPayload<{
      include: {
        passport: {
          include: {
            order: { select: { id: true; number: true } };
            product: { select: { name: true } };
            size: true;
          };
        };
        operation: { select: { id: true; code: true; name: true } };
        employee: { select: { id: true; fullName: true } };
      };
    }>,
  ): EarningDto {
    return {
      id: row.id,
      passportId: row.passportId,
      passportNumber: row.passport.number,
      orderId: row.passport.order.id,
      orderNumber: row.passport.order.number,
      productName: row.passport.product.name,
      color: row.passport.color,
      sizeId: row.passport.sizeId,
      sizeCode: row.passport.size.code,
      sizeSortOrder: row.passport.size.sortOrder,
      operationId: row.operation.id,
      operationCode: row.operation.code,
      operationName: row.operation.name,
      employeeId: row.employee.id,
      employeeFullName: row.employee.fullName,
      qty: row.qty,
      ratePerUnit: roundMoneyNumber(row.ratePerUnit),
      amount: roundMoneyNumber(row.amount),
      // Маппим legacy `PENDING` в публичный `PENDING_RELEASE`, чтобы UI
      // не разбирался в двух именах одного и того же состояния.
      status:
        row.status === EntryStatus.PENDING
          ? 'PENDING_RELEASE'
          : (row.status as EarningDto['status']),
      approvalMode: row.approvalMode as EarningDto['approvalMode'],
      sourceEventType: row.sourceEventType as EarningDto['sourceEventType'],
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    };
  }

  /**
   * `tx.operationEntry.create` обёрнутая в обработку P2002
   * (нарушение `@@unique` на ключе идемпотентности). Любая другая
   * ошибка пробрасывается наружу — это уже не дубль, а реальный сбой.
   *
   * Возвращает `true`, если запись была создана; `false` — если
   * уникальный ключ уже занят (повторный trigger). Это используется
   * cutter-аудитом, чтобы не плодить лишних строк в `AuditLog` при
   * идемпотентных повторных вызовах.
   */
  /**
   * Номер ПРОХОДА операции по маршруту заказа для ключа идемпотентности
   * (`OperationEntry.passOrdinal`): `0` — первое вхождение операции в
   * маршрут, `1` — второе и т.д.
   *
   * Операция может стоять в маршруте несколько раз (чередующиеся ОТК/ВТО
   * между швейными шагами) — тогда паспорт проходит её столько же раз, и
   * каждый проход оплачивается отдельно. Без ordinal второй проход упирался
   * бы в `@@unique` первого и молча не создавался.
   *
   * Считаем по ПОЗИЦИИ паспорта в маршруте, а не по числу закрытых событий:
   * при возврате ОТК на переделку паспорт остаётся на том же шаге, ordinal
   * не меняется, и повторное закрытие того же прохода по-прежнему не
   * оплачивается дважды. Операция вне маршрута (крой, переделка) и обычный
   * маршрут без повторов дают `0` — прежнее поведение.
   */
  private async resolvePassOrdinal(
    tx: Prisma.TransactionClient,
    args: {
      orderId: string | null;
      operationId: string;
      currentRouteStepIndex: number | null;
    },
  ): Promise<number> {
    if (!args.orderId || args.currentRouteStepIndex == null) return 0;
    const occurrences = await tx.orderRouteStep.findMany({
      where: { orderId: args.orderId, operationId: args.operationId },
      orderBy: { index: 'asc' },
      select: { index: true },
    });
    if (occurrences.length < 2) return 0;
    const at = occurrences.findIndex(
      (s) => s.index === args.currentRouteStepIndex,
    );
    return at > 0 ? at : 0;
  }

  private async safeCreate(
    tx: Prisma.TransactionClient,
    data: Prisma.OperationEntryUncheckedCreateInput,
  ): Promise<boolean> {
    try {
      await tx.operationEntry.create({ data });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// money helpers
// ---------------------------------------------------------------------------

/**
 * Округление до двух знаков. Используем half-up (не банковское) —
 * совпадает с тем, как считают на бумаге и в 1С на участке зарплат.
 */
function roundMoney(amount: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(amount.toFixed(2));
}

function roundMoneyNumber(amount: Prisma.Decimal | null | undefined): number {
  if (!amount) return 0;
  return Number(amount.toFixed(2));
}
