import { EarningSource, EntryStatus, Prisma } from '@prisma/client';
import type { PayrollCutoffBasis } from '@sewing/shared/payroll-schedule';
import { moscowDayWindow } from '../../common/moscow-date.js';

/**
 * Отсечка сдельных начислений по расписанию зарплаты.
 *
 * Единственное место, где живёт правило «что считается заработанным к
 * дню начисления». Его зовут двое: `PayrollAccrualDocumentsService`
 * (отбор строк документа) и `PayrollScheduleService` (предпросмотр
 * «войдёт / отложено»). Если бы правило было написано дважды, документ
 * и предпросмотр разъехались бы ровно в тот день, когда это дороже
 * всего — в день выплаты.
 *
 * Окладные `SalaryEntry` здесь не участвуют СОЗНАТЕЛЬНО: они не
 * привязаны к заказу вовсе (часы смены, месячный оклад, подкрой), и
 * отсечка по заказу к ним неприменима физически — они всегда идут по
 * своей дате ≤ дня начисления.
 */

/**
 * Границы дня начисления. Обе даты считает ОДНА функция, потому что их
 * две штуки и они разной природы:
 *
 *   - `cutoff` — верхняя граница по времени (`OperationEntry.createdAt`,
 *     `approvedAt`, `Order.completedAt`). Считается по МОСКОВСКИМ
 *     суткам: день начисления — это календарный день цеха, а не UTC.
 *     Раньше документ резал по `endOfDayUtc`, а предпросмотр — по
 *     московскому концу суток; разница в 3 часа означала, что ночная
 *     смена попадала в документ, но не показывалась в предпросмотре.
 *
 *   - `salaryDate` — граница для `SalaryEntry.date`, а это `@db.Date`:
 *     Prisma сравнивает его как полночь UTC, поэтому единственно
 *     верная граница «включительно по день начисления» — полночь UTC
 *     ЭТОГО дня. Московское начало суток (21:00 предыдущего дня) молча
 *     выбрасывало из предпросмотра весь день оклада.
 */
export function resolveAccrualBounds(accrualDateIso: string): {
  cutoff: Date;
  salaryDate: Date;
} {
  const { to } = moscowDayWindow(accrualDateIso);
  return {
    cutoff: new Date(to.getTime() - 1),
    salaryDate: new Date(`${accrualDateIso}T00:00:00.000Z`),
  };
}

/** Минимальная проекция настройки, от которой зависит отбор. */
export interface AccrualCutoffRules {
  cutoffBasis: PayrollCutoffBasis;
  appliesToSewing: boolean;
  appliesToCutting: boolean;
}

/**
 * Условие «начисление прошло отсечку» для одной ветки (пошив или
 * раскрой). Пустой объект = ограничения нет.
 */
function basisWhere(
  basis: PayrollCutoffBasis,
  cutoff: Date,
): Prisma.OperationEntryWhereInput {
  switch (basis) {
    case 'ORDER_COMPLETED':
      // `completedAt` проставляется ТОЛЬКО при закрытии заказа (DONE
      // или CANCELLED), поэтому `not: null` — и есть проверка «заказ
      // закрыт». Отменённый заказ считается закрытым намеренно: работа
      // по нему сделана и начислена, и ждать `DONE`, который никогда не
      // наступит, значит не заплатить людям никогда.
      return { passport: { order: { completedAt: { not: null, lte: cutoff } } } };
    case 'PASSPORT_PACKED':
      // Подтверждение сдельщины = закрытие коробки
      // (`EarningsService.approvePendingForPassport`).
      return { approvedAt: { not: null, lte: cutoff } };
    case 'WORK_DATE':
    default:
      // Поведение до появления расписания: достаточно того, что
      // начисление создано до даты (базовое условие ниже).
      return {};
  }
}

/**
 * `where` для сдельных начислений, попадающих в документ на дату
 * начисления. `cutoff` — верхняя граница включительно (конец
 * московских суток дня начисления).
 *
 * Раскрой (`sourceEventType = PASSPORT_CREATED`) и пошив разведены в
 * две ветки: у них разный момент оплаты. Раскройщик получает деньги при
 * выпуске паспорта, задолго до закрытия заказа, поэтому по умолчанию
 * он выведен из-под правила (`appliesToCutting = false`) — иначе он
 * ждал бы вместе со всеми, ничего не выиграв.
 */
export function pieceworkAccrualWhere(
  rules: AccrualCutoffRules,
  cutoff: Date,
): Prisma.OperationEntryWhereInput {
  const rule = basisWhere(rules.cutoffBasis, cutoff);
  const cutting: Prisma.OperationEntryWhereInput = {
    sourceEventType: EarningSource.PASSPORT_CREATED,
    ...(rules.appliesToCutting ? rule : {}),
  };
  const sewing: Prisma.OperationEntryWhereInput = {
    sourceEventType: { not: EarningSource.PASSPORT_CREATED },
    ...(rules.appliesToSewing ? rule : {}),
  };
  return {
    status: EntryStatus.APPROVED,
    createdAt: { lte: cutoff },
    OR: [cutting, sewing],
  };
}

/** Базовое условие БЕЗ отсечки — «всё, что вообще могло бы войти». */
export function pieceworkCandidateWhere(
  cutoff: Date,
): Prisma.OperationEntryWhereInput {
  return { status: EntryStatus.APPROVED, createdAt: { lte: cutoff } };
}

/**
 * Прошла ли конкретная строка отсечку — та же логика, что в
 * `pieceworkAccrualWhere`, но в памяти: нужна предпросмотру, который
 * грузит кандидатов один раз и делит их на «войдёт» и «отложено», а не
 * гоняет два симметричных запроса (они разъезжаются при любой правке).
 */
export function passesAccrualCutoff(
  rules: AccrualCutoffRules,
  cutoff: Date,
  entry: {
    sourceEventType: EarningSource;
    approvedAt: Date | null;
    orderCompletedAt: Date | null;
  },
): boolean {
  const isCutting = entry.sourceEventType === EarningSource.PASSPORT_CREATED;
  const applies = isCutting ? rules.appliesToCutting : rules.appliesToSewing;
  if (!applies) return true;
  switch (rules.cutoffBasis) {
    case 'ORDER_COMPLETED':
      return (
        entry.orderCompletedAt !== null && entry.orderCompletedAt <= cutoff
      );
    case 'PASSPORT_PACKED':
      return entry.approvedAt !== null && entry.approvedAt <= cutoff;
    case 'WORK_DATE':
    default:
      return true;
  }
}
