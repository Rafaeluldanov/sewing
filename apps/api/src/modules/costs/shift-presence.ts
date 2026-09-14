/**
 * Аудит движка расчёта 13.09.2026, F1-1 / F1-2: общий признак «окладник был
 * на смене в этот день» и сколько минут этого дня ему оплачено — источник
 * для расчёта простоя в дневном отчёте (`CostsService`) и в отчёте v2
 * (`ProductionCostV2Service.computeSalarySplit`).
 *
 * До этого оба отчёта брали присутствие из «любой `SalaryEntry` за день»:
 * месячник (одна строка `MONTH_SALARY` на 1-е число) получал 480 мин
 * простоя 1-го числа и 0 во все рабочие дни, а ручная премия `MANUAL`
 * рисовала простой в выходной. Дашборд (`DashboardService.computeRoleLoad`)
 * этот случай уже разбирал через `ShiftSession` — здесь то же правило
 * вынесено в одну точку для отчётов себестоимости.
 *
 * Правило:
 *   - почасовик — строка `SalaryEntry` с `source = SHIFT_DAY` за день
 *     (`SalaryService.syncDailySalary` создаёт её только по закрытой
 *     смене); оплачено = `workedSeconds / 60`, для legacy-строк без
 *     `workedSeconds` (плоская ставка до ревизии ADR-0021) — `SHIFT_MINUTES`;
 *   - месячник (`SalaryRateMode.MONTHLY`) — дневных строк нет по построению,
 *     присутствие = закрытые `ShiftSession` за UTC-день, оплачено = их
 *     суммарная длительность, каждая смена — не больше предохранителя K7
 *     (`salary/shift-worked-cap.ts`: `shiftMaxDurationHours` или 16 ч) —
 *     ровно как `computeWorkedSeconds` в ведомости (ревью F1-2: иначе
 *     забытая смена пт→пн давала месячнику 4 380 мин простоя ≈ 39 000 ₽,
 *     когда почасовик через `SalaryEntry.workedSeconds` предохранитель
 *     получал);
 *   - `MANUAL` / `RECUT` / `MONTH_SALARY` признаком смены не являются:
 *     премия и доплата за подкрой не говорят о присутствии, месячная
 *     строка датирована 1-м числом.
 *
 * Простой затем считается как `max(0, оплачено − разнесено)`, а не
 * `480 − разнесено`: после перехода на почасовую оплату «оплачено» — это
 * `workedSeconds`, и полсмены не должны давать 420 мин простоя.
 */
import { SalaryEntrySource, SalaryRateMode } from '@prisma/client';
import { SHIFT_MINUTES } from '@sewing/shared/costs';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  cappedWorkedSeconds,
  resolveShiftWorkedCapSeconds,
} from '../salary/shift-worked-cap.js';

export interface ShiftPresence {
  /**
   * Оплаченные минуты по ключу `${employeeId}|${YYYY-MM-DD}` (UTC-день).
   * Наличие ключа = сотрудник был на смене в этот день.
   */
  paidMinutesByEmpDay: Map<string, number>;
  /** Сотрудники, у которых есть хотя бы один день присутствия в окне. */
  employeeIds: string[];
}

export async function loadShiftPresence(
  prisma: PrismaService,
  from: Date,
  to: Date,
): Promise<ShiftPresence> {
  const [shiftDays, monthlySessions, capSeconds] = await Promise.all([
    prisma.salaryEntry.findMany({
      where: {
        date: { gte: from, lte: to },
        source: SalaryEntrySource.SHIFT_DAY,
      },
      select: { employeeId: true, date: true, workedSeconds: true },
    }),
    prisma.shiftSession.findMany({
      where: {
        startedAt: { gte: from, lte: to },
        endedAt: { not: null },
        employee: { salaryRateMode: SalaryRateMode.MONTHLY },
      },
      select: { employeeId: true, startedAt: true, endedAt: true },
    }),
    // Аудит 13.09.2026, F1-2 (ревью): тот же предел, что у ведомости.
    resolveShiftWorkedCapSeconds(prisma),
  ]);

  const paidMinutesByEmpDay = new Map<string, number>();
  for (const s of shiftDays) {
    const key = `${s.employeeId}|${toDateKey(s.date)}`;
    const paid =
      s.workedSeconds !== null && s.workedSeconds > 0
        ? s.workedSeconds / 60
        : SHIFT_MINUTES;
    // Одна строка SHIFT_DAY на сотрудника×день (уникальный индекс) —
    // `Math.max` только на случай двух дат, схлопнувшихся в один UTC-день.
    paidMinutesByEmpDay.set(
      key,
      Math.max(paidMinutesByEmpDay.get(key) ?? 0, paid),
    );
  }
  // Ключи, уже оплаченные по сменам месячника (несколько закрытых смен
  // за день суммируются).
  const monthlyKeys = new Set<string>();
  for (const s of monthlySessions) {
    if (!s.endedAt) continue;
    const minutes = cappedWorkedSeconds(s.startedAt, s.endedAt, capSeconds) / 60;
    if (minutes <= 0) continue;
    const key = `${s.employeeId}|${toDateKey(s.startedAt)}`;
    // Строка SHIFT_DAY у месячника — legacy (переведён с часов); смены
    // сверх неё не суммируем, чтобы не платить день дважды.
    if (paidMinutesByEmpDay.has(key) && !monthlyKeys.has(key)) continue;
    monthlyKeys.add(key);
    paidMinutesByEmpDay.set(key, (paidMinutesByEmpDay.get(key) ?? 0) + minutes);
  }

  const employeeIds = Array.from(
    new Set(
      Array.from(paidMinutesByEmpDay.keys()).map((k) =>
        k.slice(0, k.lastIndexOf('|')),
      ),
    ),
  );
  return { paidMinutesByEmpDay, employeeIds };
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
