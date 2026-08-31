import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantContext } from '../../prisma/tenant-context.js';
import { AuditService } from '../audit/audit.service.js';
import { SalaryService } from '../salary/salary.service.js';
import { closeShiftSegments } from './shift-segments.js';
import {
  isAutoClosePolicyEnabled,
  resolveShiftDeadline,
  resolveShiftEndedAt,
  type ShiftAutoClosePolicy,
} from './shift-auto-close.js';

/**
 * Автозавершение смен, забытых открытыми.
 *
 * Зачем. Смена не связана с сессией и не закрывается сама: человек
 * уходит домой, не нажав «Завершить смену». На проде на 31.08.2026 из
 * 755 закрытых смен 429 длиннее 10 часов, 194 — дольше суток (рекорд
 * 68 суток). Часы, загрузка и выработка в час после такого
 * недостоверны, а мастер узнаёт об этом из отчёта, когда исправлять
 * поздно.
 *
 * Почему без крона. Планировщика (`@nestjs/schedule`) в проекте нет, и
 * заводить его ради одной задачи в сутки — новая зависимость в
 * контейнерах и вторая точка отказа. Тот же приём уже применён для
 * автосоздания черновика начисления (`PayrollScheduleService.ensureDueDraft`):
 * проверку дёргают экраны, которым эти данные и нужны — табель мастера,
 * тайм-трекер админки и старт новой смены. На практике первый же заход
 * мастера утром чинит вчерашний день; смена, начатая заново, чинит его
 * ещё раньше.
 *
 * Идемпотентность. Закрытие идёт `updateMany` с условием `endedAt =
 * null`, поэтому параллельные вызовы из двух экранов не удваивают
 * записи и не перетирают уже закрытую смену. Плюс троттлинг: чаще раза
 * в минуту процесс не сканирует.
 *
 * Чего сервис сознательно НЕ делает:
 *   - не трогает `RecutSession` (подкрой) — там своя оплата по таймеру
 *     и своё правило завершения;
 *   - не «поднимает» уже закрытые смены и не правит их часы задним
 *     числом: исторические данные остаются как есть, лечится только то,
 *     что открыто прямо сейчас.
 */

/** Не сканируем чаще, чем раз в эту паузу (на процесс и тенанта). */
const SCAN_THROTTLE_MS = 60_000;

/**
 * Ограничение на один проход. Смен в цехе десятки, но на первом
 * запуске после включения настройки открытых может оказаться много —
 * не хотим держать запрос экрана, пока закрываются сотни.
 */
const MAX_PER_RUN = 100;

@Injectable()
export class ShiftAutoCloseService {
  private readonly logger = new Logger(ShiftAutoCloseService.name);
  /** Последний скан по тенантам (DB-per-tenant, общий счётчик нельзя). */
  private readonly lastScanAt = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantContext) private readonly tenantContext: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SalaryService) private readonly salary: SalaryService,
  ) {}

  /**
   * Закрывает просроченные смены, если с прошлого скана прошла минута.
   * Fail-soft: любая ошибка съедается — экран, который дёрнул проверку,
   * не должен падать из-за неё.
   *
   * `employeeId` сужает проход до одного сотрудника (старт смены): там
   * важно закрыть именно СВОЮ забытую смену, а сканировать цех незачем.
   */
  async runIfDue(employeeId?: string): Promise<number> {
    try {
      const tenantKey = this.tenantContext.getStore()?.tenantId ?? 'default';
      const now = Date.now();
      if (!employeeId) {
        const last = this.lastScanAt.get(tenantKey) ?? 0;
        if (now - last < SCAN_THROTTLE_MS) return 0;
        this.lastScanAt.set(tenantKey, now);
      }
      return await this.run(employeeId);
    } catch (e) {
      this.logger.warn(
        `event=shift.autoClose.failed reason=${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return 0;
    }
  }

  /** Проход без троттлинга — для явного вызова и тестов. */
  async run(employeeId?: string): Promise<number> {
    const policy = await this.loadPolicy();
    if (!isAutoClosePolicyEnabled(policy)) return 0;

    const now = new Date();
    const open = await this.prisma.shiftSession.findMany({
      where: { endedAt: null, ...(employeeId ? { employeeId } : {}) },
      select: { id: true, employeeId: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: MAX_PER_RUN,
    });
    if (open.length === 0) return 0;

    const overdue = open
      .map((s) => ({ ...s, deadline: resolveShiftDeadline(s.startedAt, policy) }))
      .filter(
        (s): s is typeof s & { deadline: Date } =>
          s.deadline !== null && s.deadline <= now,
      );
    if (overdue.length === 0) return 0;

    const activity = await this.loadLastActivity(overdue);

    let closed = 0;
    for (const shift of overdue) {
      const endedAt = resolveShiftEndedAt({
        startedAt: shift.startedAt,
        deadline: shift.deadline,
        lastActivityAt: activity.get(shift.id) ?? null,
        mode: policy.mode,
      });
      const ok = await this.closeSession({
        sessionId: shift.id,
        employeeId: shift.employeeId,
        startedAt: shift.startedAt,
        endedAt,
        closedAt: now,
      });
      if (!ok) continue;
      closed += 1;
      this.logger.log(
        `event=shift.autoClose shiftId=${shift.id} employeeId=${shift.employeeId} startedAt=${shift.startedAt.toISOString()} endedAt=${endedAt.toISOString()} mode=${policy.mode}`,
      );
      await this.audit.log({
        event: 'SHIFT_AUTO_CLOSED',
        entityType: 'SHIFT_SESSION',
        entityId: shift.id,
        // Автора нет — закрыла система; `employeeId` аудита оставляем
        // пустым, а сотрудник смены едет в payload.
        employeeId: null,
        payload: {
          targetEmployeeId: shift.employeeId,
          startedAt: shift.startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          deadline: shift.deadline.toISOString(),
          mode: policy.mode,
          openHours:
            Math.round(
              ((now.getTime() - shift.startedAt.getTime()) / 3_600_000) * 10,
            ) / 10,
        },
      });
    }
    return closed;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Закрывает одну смену временем `endedAt`.
   *
   * Отличия от `ShiftsService.stop`: работает по `sessionId` (сканер уже
   * знает строку), время задаётся снаружи и может быть заметно раньше
   * `now`, и проставляется `autoClosedAt` — в табеле видно, что смену
   * закрыл не человек.
   *
   * `updateMany` с условием `endedAt: null` делает операцию
   * идемпотентной: если сотрудник закрылся сам между выборкой и
   * записью, его время не перетирается. `false` — закрывать было нечего.
   *
   * Живёт здесь, а не в `ShiftsService`, чтобы зависимость шла в одну
   * сторону: старт смены зовёт автозакрытие, а не наоборот.
   */
  private async closeSession(args: {
    sessionId: string;
    employeeId: string;
    startedAt: Date;
    endedAt: Date;
    closedAt: Date;
  }): Promise<boolean> {
    const res = await this.prisma.shiftSession.updateMany({
      where: { id: args.sessionId, endedAt: null },
      data: { endedAt: args.endedAt, autoClosedAt: args.closedAt },
    });
    if (res.count === 0) return false;
    // Табель дня: отрезки закрываются тем же временем, что и смена —
    // иначе сумма сегментов разойдётся с её длительностью.
    await closeShiftSegments(this.prisma, args.sessionId, args.endedAt);
    // Оклад считается по дню НАЧАЛА смены (как в `ShiftsService.stop`):
    // ночное автозакрытие не должно сдвигать начисление на следующий
    // день. Ошибки синхронизации не роняют закрытие — зарплата
    // выровняется на следующем `start`/`stop`.
    try {
      await this.salary.syncDailySalary(args.employeeId, args.startedAt);
    } catch (err) {
      this.logger.warn(
        `syncDailySalary failed after auto-close (employeeId=${args.employeeId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  /**
   * Настройка организации. Читаем singleton напрямую (как соседние
   * hardening-геттеры) и fail-soft: на свежей БД строки ещё нет, а на
   * проде между деплоем контейнеров и `prisma migrate deploy` нет и
   * колонок — правило в этом окне просто выключено.
   */
  private async loadPolicy(): Promise<ShiftAutoClosePolicy> {
    try {
      const row = await this.prisma.companySettings.findUnique({
        where: { id: 'default' },
        select: {
          shiftAutoCloseTime: true,
          shiftMaxDurationHours: true,
          shiftAutoCloseMode: true,
        },
      });
      return {
        closeAtMinutes: parseTimeOfDay(row?.shiftAutoCloseTime ?? null),
        maxDurationHours: row?.shiftMaxDurationHours ?? 0,
        mode: row?.shiftAutoCloseMode ?? 'LAST_ACTIVITY',
      };
    } catch (e) {
      this.logger.warn(
        `event=shift.autoClose.policyUnavailable reason=${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { closeAtMinutes: null, maxDurationHours: 0, mode: 'LAST_ACTIVITY' };
    }
  }

  /**
   * Последняя отметка сотрудника в каждой смене: `shiftSessionId → Date`.
   *
   * Отметками считаем события паспортов этого сотрудника (взял крой,
   * закрыл операцию, скан) и начала отрезков смены — переключение
   * операции тоже действие человека. Начало самой смены добавляет
   * `resolveShiftEndedAt`, поэтому здесь нижней границы нет.
   *
   * Почему не «последний запрос к API»: такого следа в проекте нет, а
   * заводить его ради этой фичи означало бы писать в БД на каждый
   * запрос — ровно то, чего мы избежали в автовыходе по бездействию.
   */
  private async loadLastActivity(
    shifts: Array<{ id: string; employeeId: string; startedAt: Date }>,
  ): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (shifts.length === 0) return out;

    const employeeIds = Array.from(new Set(shifts.map((s) => s.employeeId)));
    const since = shifts.reduce(
      (min, s) => (s.startedAt < min ? s.startedAt : min),
      shifts[0]!.startedAt,
    );

    const [events, segments] = await Promise.all([
      this.prisma.passportEvent.findMany({
        where: { employeeId: { in: employeeIds }, createdAt: { gte: since } },
        select: { employeeId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.shiftSegment.findMany({
        where: { shiftSessionId: { in: shifts.map((s) => s.id) } },
        select: { shiftSessionId: true, startedAt: true, endedAt: true },
      }),
    ]);

    // События привязаны к сотруднику, а не к смене: относим их к той
    // смене этого сотрудника, которая шла в тот момент. Смен на
    // сотрудника открыто не больше одной (partial unique index), так
    // что достаточно проверить `createdAt >= startedAt`.
    for (const shift of shifts) {
      let last: Date | null = null;
      for (const e of events) {
        if (e.employeeId !== shift.employeeId) continue;
        if (e.createdAt < shift.startedAt) continue;
        if (!last || e.createdAt > last) last = e.createdAt;
      }
      for (const seg of segments) {
        if (seg.shiftSessionId !== shift.id) continue;
        for (const mark of [seg.startedAt, seg.endedAt]) {
          if (!mark) continue;
          if (!last || mark > last) last = mark;
        }
      }
      if (last) out.set(shift.id, last);
    }
    return out;
  }
}

/** `"HH:MM"` → минуты от полуночи; мусор и пустое значение → `null`. */
function parseTimeOfDay(value: string | null): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number.parseInt(m[1]!, 10) * 60 + Number.parseInt(m[2]!, 10);
}
