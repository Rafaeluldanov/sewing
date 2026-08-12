import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EmployeeQrResponseDto,
  EmployeeQrTokenPayload,
} from '@sewing/shared/employee-qr';
import { EMPLOYEE_QR_PAYLOAD_PREFIX } from '@sewing/shared/employee-qr';
import type {
  CompensationType as SharedCompensationType,
  MeDailyDto,
  MeDailyOperationDto,
  MeHistoryDto,
  MeHistoryDayDto,
  MeHistoryQuery,
} from '@sewing/shared/me-daily';
import type {
  MyWorkplacesDto,
  SwitchWorkplaceDto,
  SwitchWorkplaceResultDto,
} from '@sewing/shared/workplace';
import { normalizeAssignedRoles } from '@sewing/shared/employees';
import {
  SYSTEM_ROLE_DEFAULTS,
  isSystemRoleCode,
} from '@sewing/shared/app-roles';
import {
  CompensationType as PrismaCompensationType,
  EntryStatus,
  PassportStatus,
  Prisma,
  SalaryEntrySource,
  SalaryRateMode,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EmployeeProfileNotFoundException,
  EmployeeInactiveForbiddenException,
  EquipmentInactiveException,
  EquipmentNotFoundException,
  WorkplaceNoRoleException,
  WorkplaceRoleForbiddenException,
  WorkplaceSwitchConfirmRequiredException,
} from '../../common/errors.js';
import {
  EMPLOYEE_QR_DEFAULT_TTL_SECONDS,
  signEmployeeQrToken,
  verifyEmployeeQrToken,
} from '../auth/employee-qr-token.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { closeShiftSegments } from '../shifts/shift-segments.js';
import { startOfMonthUtc } from '@sewing/shared/payroll-calendar';
import { resolveEffectiveHourlyRate } from '../salary/salary-rate.js';

/**
 * Сервис личного кабинета сотрудника (`GET /api/me/*`).
 *
 * Содержит read-only методы, нужные для шапки/виджетов в кабинете:
 *   - `buildEmployeeQr` — подписанный QR-код сотрудника;
 *   - `getDaily` — выработка и начисления за сегодня (по Москве);
 *   - `getHistory` — те же метрики по дням за последние N дней.
 *
 * Политика `PENDING` тут сознательно отличается от
 * `EarningsService.summary`/`list` для не-менеджеров: в личном
 * кабинете сотрудник видит свои `PENDING_RELEASE` (отдельной строкой
 * с пометкой), потому что в течение дня основная часть его сделки
 * сидит именно в этом статусе до закрытия коробки упаковщиком. Чужие
 * pending по-прежнему недоступны (запрос строго по
 * `viewer.employeeId`).
 */
@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const secret = config.get<string>('JWT_SECRET') ?? '';
    if (!secret || secret === 'change-me-in-prod') {
      this.logger.warn(
        'JWT_SECRET is missing or default — QR-токены будут подписаны dev-fallback секретом',
      );
    }
    this.secret = secret || 'sewing-dev-fallback-secret';
    this.ttlSeconds = EMPLOYEE_QR_DEFAULT_TTL_SECONDS;
  }

  // ===========================================================================
  // QR-код сотрудника
  // ===========================================================================

  /**
   * Выдаёт DTO ответа `GET /api/me/employee-qr`. Дополнительно
   * перепроверяет `active = true` у живой карточки — это
   * defence-in-depth на случай, если `AuthGuard` в будущем ослабят.
   *
   * Ошибки:
   *   - 404 `EMPLOYEE_PROFILE_NOT_FOUND` — карточки нет в БД.
   *   - 403 `EMPLOYEE_INACTIVE` — карточка есть, но `active=false`.
   */
  async buildEmployeeQr(
    principal: AuthPrincipal,
    now: Date = new Date(),
  ): Promise<EmployeeQrResponseDto> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: { id: true, fullName: true, role: true, active: true },
    });
    if (!employee) throw new EmployeeProfileNotFoundException();
    if (!employee.active) throw new EmployeeInactiveForbiddenException();

    const { token, expiresAt } = signEmployeeQrToken(
      {
        employeeId: employee.id,
        userId: employee.id,
        role: employee.role,
      },
      { secret: this.secret, ttlSeconds: this.ttlSeconds },
      now,
    );

    return {
      employee: {
        id: employee.id,
        name: employee.fullName,
        role: employee.role,
      },
      qrPayload: `${EMPLOYEE_QR_PAYLOAD_PREFIX}${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Проверка подписи QR-токена — для будущих master-flow.
   */
  verifyEmployeeQrToken(
    token: string,
    now: Date = new Date(),
  ): EmployeeQrTokenPayload | null {
    return verifyEmployeeQrToken(token, { secret: this.secret }, now);
  }

  // ===========================================================================
  // POST /api/me/switch-workplace — смена активной роли сканом рабочего места
  // ===========================================================================

  /**
   * Переключает активный рабочий экран сотрудника, сканируя QR
   * «рабочего места» (`Equipment.qrCode = equipment:{id}`). Фича
   * «несколько ролей» (см. `Equipment.role`, `Employee.roles/activeRole`).
   *
   * Алгоритм:
   *   1. Резолвим оборудование по коду (формат `equipment:{id}`, голый
   *      `id` или человекочитаемый `Equipment.code`).
   *   2. Оборудование должно быть активным и иметь привязанную роль
   *      (`Equipment.role`), иначе `WORKPLACE_NO_ROLE`.
   *   3. Роль рабочего места обязана входить в `Employee.roles`
   *      сотрудника, иначе `WORKPLACE_ROLE_FORBIDDEN`.
   *   4. Если есть открытая смена с незавершённой работой (паспорт на
   *      руках, `currentEmployeeId = me AND status = IN_PROGRESS`) и не
   *      передан `force` — `409 WORKPLACE_SWITCH_CONFIRM_REQUIRED`
   *      (UI показывает подтверждение и повторяет с `force: true`).
   *   5. Закрываем открытую смену (если была) и проставляем
   *      `Employee.activeRole`. Куда вести пользователя, решает фронт
   *      по возвращённой роли (`getPrimaryWorkspace`).
   *
   * Окладную синхронизацию при закрытии смены не дёргаем: `SalaryEntry`
   * за день уже создан на старте смены (см. `ShiftsService.start`),
   * а оклад не зависит от факта закрытия.
   */
  async switchWorkplace(
    principal: AuthPrincipal,
    dto: SwitchWorkplaceDto,
  ): Promise<SwitchWorkplaceResultDto> {
    // Два входа в один и тот же переход: скан QR рабочего места и выбор
    // участка в списке. Скан дополнительно называет оборудование —
    // поэтому только он заполняет `equipment*` в ответе.
    const equipment = dto.code
      ? await this.resolveEquipmentByCode(dto.code)
      : null;
    let role: string;
    if (dto.code) {
      if (!equipment) throw new EquipmentNotFoundException();
      if (!equipment.active) throw new EquipmentInactiveException();
      if (!equipment.role) throw new WorkplaceNoRoleException();
      role = equipment.role;
    } else {
      role = dto.role!;
    }

    // Проверяем по НАЗНАЧЕННОМУ набору: наследование даёт права, но не
    // отдельный участок — переключаться можно только на то, что реально
    // выдано сотруднику (и что показывает `listWorkplaces`).
    const assigned = await this.loadAssignedRoles(principal);
    if (!assigned.includes(role)) {
      throw new WorkplaceRoleForbiddenException();
    }

    const activeShift = await this.prisma.shiftSession.findFirst({
      where: { employeeId: principal.employeeId, endedAt: null },
      select: { id: true },
    });
    let closedShiftId: string | null = null;
    if (activeShift) {
      if (!dto.force) {
        const unfinished = await this.prisma.passport.count({
          where: {
            currentEmployeeId: principal.employeeId,
            status: PassportStatus.IN_PROGRESS,
          },
        });
        if (unfinished > 0) {
          throw new WorkplaceSwitchConfirmRequiredException();
        }
      }
      const endedAt = new Date();
      await this.prisma.shiftSession.update({
        where: { id: activeShift.id },
        data: { endedAt },
      });
      // Табель дня (`ShiftSegment`): переход на другой участок закрывает
      // смену НЕ через `ShiftsService.stop`, поэтому отрезок закрываем
      // здесь же — иначе он остался бы открытым навсегда и «где был»
      // показывало бы ВТО до конца времён.
      await closeShiftSegments(this.prisma, activeShift.id, endedAt);
      closedShiftId = activeShift.id;
    }

    await this.prisma.employee.update({
      where: { id: principal.employeeId },
      data: { activeRole: role },
    });

    this.logger.log(
      `event=me.switch-workplace employeeId=${principal.employeeId} equipmentId=${equipment?.id ?? 'none'} role=${role} via=${dto.code ? 'scan' : 'list'} closedShift=${closedShiftId ?? 'none'}`,
    );

    return {
      role,
      equipmentId: equipment?.id ?? null,
      equipmentName: equipment?.name ?? null,
      equipmentDisplayNumber: equipment?.displayNumber ?? null,
      closedShiftId,
    };
  }

  /**
   * Участки сотрудника для шторки «Сменить участок»
   * (`GET /api/me/workplaces`).
   *
   * Берём НАЗНАЧЕННЫЕ роли (`Employee.roles`), а не эффективные из
   * `principal`: раскрытое наследование добавляет права донора, но не
   * отдельное рабочее место, и роль-донор выглядела бы в списке
   * фантомным участком, на который «переключились», а экран тот же.
   *
   * Названия и экраны — из справочника `AppRole` (там же живут
   * кастомные роли); для системных ролей есть fallback в коде, поэтому
   * пустой/недосеянный справочник список не ломает.
   */
  async listWorkplaces(principal: AuthPrincipal): Promise<MyWorkplacesDto> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: { role: true, roles: true, activeRole: true },
    });
    if (!employee) throw new EmployeeProfileNotFoundException();

    const assigned = normalizeAssignedRoles(employee.role, employee.roles);
    const currentRole = employee.activeRole ?? employee.role;
    const catalog = await this.prisma.appRole.findMany({
      where: { code: { in: assigned } },
      select: { code: true, name: true, workspace: true, sortOrder: true },
    });
    const byCode = new Map(catalog.map((r) => [r.code, r]));

    const workplaces = assigned
      .map((code) => {
        const row = byCode.get(code);
        const fallback = isSystemRoleCode(code)
          ? SYSTEM_ROLE_DEFAULTS[code]
          : null;
        return {
          role: code,
          label: row?.name ?? fallback?.name ?? code,
          workspace: row?.workspace ?? fallback?.workspace ?? '/',
          current: code === currentRole,
          primary: code === employee.role,
          sortOrder: row?.sortOrder ?? fallback?.sortOrder ?? 999,
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ sortOrder: _sortOrder, ...w }) => w);

    return { workplaces };
  }

  /**
   * Назначенный набор ролей сотрудника. `principal.roles` для проверки
   * доступа к участку не годится — он эффективный (с раскрытым
   * наследованием), а переключаться можно только на выданное.
   */
  private async loadAssignedRoles(
    principal: AuthPrincipal,
  ): Promise<string[]> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: { role: true, roles: true },
    });
    if (!employee) throw new EmployeeProfileNotFoundException();
    return normalizeAssignedRoles(employee.role, employee.roles);
  }

  /**
   * Резолвит `Equipment` по сырой строке из QR-сканера. Поддерживает те
   * же три формата, что и `matchEquipmentByCode` на фронте:
   *   - `equipment:{id}` (ADR-0008) → ищем по `id`;
   *   - голый `id` (если QR уже распарсен) → по `id`;
   *   - человекочитаемый `Equipment.code` → по `code`.
   */
  private async resolveEquipmentByCode(raw: string) {
    const trimmed = raw.trim();
    const candidate = trimmed.startsWith('equipment:')
      ? trimmed.slice('equipment:'.length)
      : trimmed;
    const byId = await this.prisma.equipment.findUnique({
      where: { id: candidate },
    });
    if (byId) return byId;
    return this.prisma.equipment.findUnique({ where: { code: candidate } });
  }

  // ===========================================================================
  // GET /api/me/daily — выработка и начисления за сегодня
  // ===========================================================================

  /**
   * Возвращает дневной snapshot для виджета «Мой день».
   *
   * Логика выдачи блоков зависит от `Employee.compensationType`:
   *   - `PIECEWORK` → `piecework` есть (даже если 0 операций), `salary = null`;
   *   - `SALARY`    → `piecework = null`, `salary` есть (с `amount = 0`, если
   *     запись `SalaryEntry` за сегодня не появилась);
   *   - `MIXED`     → оба блока;
   *   - `null`/неизвестно → оба `null`, `total = 0` (UI прячет чип).
   *
   * Если карточка сотрудника удалена или деактивирована, метод
   * возвращает пустой snapshot (а не бросает 403/404): кабинет уже
   * прошёл `AuthGuard`, и для виджета достаточно «показать пусто и
   * скрыть». 403/404 для деактивированной карточки уже отдаёт
   * `buildEmployeeQr` — там это критично, тут — нет.
   */
  async getDaily(
    principal: AuthPrincipal,
    now: Date = new Date(),
  ): Promise<MeDailyDto> {
    const { date, startUtc, endUtc, dayDateUtc } = mskDayBounds(now);

    const employee = await this.prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: {
        id: true,
        active: true,
        compensationType: true,
        salaryRateMode: true,
        salaryPerHour: true,
        salaryPerMonth: true,
      },
    });
    if (!employee || !employee.active) {
      return emptyDaily(date);
    }

    const compType = toSharedCompType(employee.compensationType);
    const needsPiecework = compType === 'PIECEWORK' || compType === 'MIXED';
    const needsSalary = compType === 'SALARY' || compType === 'MIXED';
    // Месячник (29.07.2026): дневных строк `SHIFT_DAY` у него нет, всё
    // начисление месяца — одна строка `MONTH_SALARY` на 1-м числе.
    // Ищем именно её, иначе рабочий видел бы вечный ноль.
    const isMonthly = employee.salaryRateMode === SalaryRateMode.MONTHLY;
    const monthStartUtc = startOfMonthUtc(
      dayDateUtc.getUTCFullYear(),
      dayDateUtc.getUTCMonth() + 1,
    );

    const [pieceworkRows, salaryRow, openShift] = await Promise.all([
      needsPiecework
        ? this.prisma.operationEntry.findMany({
            where: {
              employeeId: employee.id,
              createdAt: { gte: startUtc, lte: endUtc },
            },
            select: {
              qty: true,
              amount: true,
              status: true,
              operation: {
                select: { id: true, code: true, name: true },
              },
            },
          })
        : Promise.resolve([]),
      needsSalary
        ? this.prisma.salaryEntry.findUnique({
            where: {
              SalaryEntry_employee_date_source_uniq: {
                employeeId: employee.id,
                date: isMonthly ? monthStartUtc : dayDateUtc,
                source: isMonthly
                  ? SalaryEntrySource.MONTH_SALARY
                  : SalaryEntrySource.SHIFT_DAY,
              },
            },
            select: { amount: true },
          })
        : Promise.resolve(null),
      needsSalary
        ? this.prisma.shiftSession.findFirst({
            where: { employeeId: employee.id, endedAt: null },
            orderBy: { startedAt: 'desc' },
            select: { startedAt: true },
          })
        : Promise.resolve(null),
    ]);

    const piecework = needsPiecework
      ? aggregatePieceworkRows(pieceworkRows)
      : null;
    // Ставка ₽/час для подсказки: у месячника она производная от
    // нормы часов месяца (см. `salary-rate.ts`), у почасовика — своя.
    const ratePerHour = needsSalary
      ? await resolveEffectiveHourlyRate(this.prisma, employee, now)
      : null;
    const salary: MeDailyDto['salary'] = needsSalary
      ? {
          // Дневная сумма: у месячника её не существует — оклад
          // начислен за месяц целиком и лежит в `monthlyAmount`.
          // Складывать его в дневной итог нельзя: рабочий увидел бы
          // «заработано сегодня» размером в месячную зарплату.
          amount: isMonthly ? 0 : decimalToNumber(salaryRow?.amount ?? null),
          shiftOpen: !!openShift,
          shiftStartedAt: openShift?.startedAt.toISOString() ?? null,
          salaryPerHour:
            ratePerHour === null ? null : Number(ratePerHour.toFixed(2)),
          hasEntryToday: !isMonthly && !!salaryRow,
          rateMode: isMonthly ? 'MONTHLY' : 'HOURLY',
          monthlyAmount: isMonthly
            ? decimalToNumber(salaryRow?.amount ?? null)
            : null,
        }
      : null;

    const total =
      (piecework?.totalAmount ?? 0) + (salary?.amount ?? 0);

    return {
      date,
      compensationType: compType,
      piecework,
      salary,
      total: roundMoneyNumber(total),
    };
  }

  // ===========================================================================
  // GET /api/me/history — история по дням
  // ===========================================================================

  /**
   * История выработки и начислений по дням за последние `days` суток
   * по Europe/Moscow (включая сегодня). Дни без активности
   * включаются с нулями — UI рисует их как «выходной».
   *
   * Сделка считается по `OperationEntry.createdAt` (день создания),
   * оклад — по `SalaryEntry.date`. Это согласуется с тем, как
   * аналогичные дни отображаются в `/admin/payroll/daily`.
   */
  async getHistory(
    principal: AuthPrincipal,
    query: MeHistoryQuery,
    now: Date = new Date(),
  ): Promise<MeHistoryDto> {
    const days = query.days;
    const today = mskDayBounds(now);
    const fromMskMidnight = new Date(today.startUtc);
    fromMskMidnight.setUTCDate(fromMskMidnight.getUTCDate() - (days - 1));
    const from = formatMskDate(fromMskMidnight);

    const employee = await this.prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: { id: true, active: true },
    });
    if (!employee || !employee.active) {
      return {
        days,
        from,
        to: today.date,
        items: buildEmptyHistoryDays(today.startUtc, days),
        totalPieceworkAmount: 0,
        totalSalaryAmount: 0,
        totalAmount: 0,
      };
    }

    const [pieceworkRows, salaryRows] = await Promise.all([
      this.prisma.operationEntry.findMany({
        where: {
          employeeId: employee.id,
          createdAt: { gte: fromMskMidnight, lte: today.endUtc },
        },
        select: {
          qty: true,
          amount: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.salaryEntry.findMany({
        where: {
          employeeId: employee.id,
          date: {
            gte: dayDateUtcFromMskMidnight(fromMskMidnight),
            lte: today.dayDateUtc,
          },
        },
        select: { date: true, amount: true },
      }),
    ]);

    // Один проход — собираем map(YYYY-MM-DD → агрегаты).
    const byDate = new Map<string, MeHistoryDayDto>();
    for (let i = 0; i < days; i++) {
      const dayStart = new Date(fromMskMidnight);
      dayStart.setUTCDate(dayStart.getUTCDate() + i);
      const dateKey = formatMskDate(dayStart);
      byDate.set(dateKey, {
        date: dateKey,
        pieceworkQty: 0,
        pieceworkAmount: 0,
        pieceworkApprovedAmount: 0,
        pieceworkPendingAmount: 0,
        salaryAmount: 0,
        total: 0,
        hasPending: false,
      });
    }

    for (const row of pieceworkRows) {
      const key = formatMskDate(row.createdAt);
      const cell = byDate.get(key);
      if (!cell) continue;
      const amount = decimalToNumber(row.amount);
      cell.pieceworkQty += row.qty;
      cell.pieceworkAmount += amount;
      if (
        row.status === EntryStatus.PENDING_RELEASE ||
        row.status === EntryStatus.PENDING
      ) {
        cell.pieceworkPendingAmount += amount;
        cell.hasPending = true;
      } else if (row.status === EntryStatus.APPROVED) {
        cell.pieceworkApprovedAmount += amount;
      }
    }

    for (const row of salaryRows) {
      const key = formatMskDate(row.date);
      const cell = byDate.get(key);
      if (!cell) continue;
      cell.salaryAmount += decimalToNumber(row.amount);
    }

    let totalPieceworkAmount = 0;
    let totalSalaryAmount = 0;
    for (const cell of byDate.values()) {
      cell.pieceworkAmount = roundMoneyNumber(cell.pieceworkAmount);
      cell.pieceworkApprovedAmount = roundMoneyNumber(
        cell.pieceworkApprovedAmount,
      );
      cell.pieceworkPendingAmount = roundMoneyNumber(
        cell.pieceworkPendingAmount,
      );
      cell.salaryAmount = roundMoneyNumber(cell.salaryAmount);
      cell.total = roundMoneyNumber(cell.pieceworkAmount + cell.salaryAmount);
      totalPieceworkAmount += cell.pieceworkAmount;
      totalSalaryAmount += cell.salaryAmount;
    }

    const items = [...byDate.values()].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
    );

    return {
      days,
      from,
      to: today.date,
      items,
      totalPieceworkAmount: roundMoneyNumber(totalPieceworkAmount),
      totalSalaryAmount: roundMoneyNumber(totalSalaryAmount),
      totalAmount: roundMoneyNumber(totalPieceworkAmount + totalSalaryAmount),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers (private to module)
// ---------------------------------------------------------------------------

/**
 * Границы «сегодня по Москве» в UTC. Москва — UTC+3 без перехода на
 * летнее время с 2014 года, поэтому смещение фиксированное и не
 * требует Intl.
 *
 * Возвращает:
 *   - `date`        — YYYY-MM-DD сегодняшнего MSK-дня;
 *   - `startUtc`    — момент полуночи MSK (= 21:00 UTC предыдущего дня);
 *   - `endUtc`      — конец дня MSK (= 20:59:59.999 UTC текущего/след. дня);
 *   - `dayDateUtc`  — `Date` полуночи UTC того же календарного дня
 *                     (для match с `SalaryEntry.date`, который Prisma
 *                     хранит как полночь UTC).
 */
function mskDayBounds(now: Date): {
  date: string;
  startUtc: Date;
  endUtc: Date;
  dayDateUtc: Date;
} {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const mskNowMs = now.getTime() + MSK_OFFSET_MS;
  const mskNow = new Date(mskNowMs);
  // YYYY-MM-DD в MSK берём через UTC-getter'ы у сдвинутой даты.
  const y = mskNow.getUTCFullYear();
  const m = mskNow.getUTCMonth();
  const d = mskNow.getUTCDate();
  // Полночь MSK в UTC = (Y-M-D 00:00:00 UTC) - 3h
  const startUtc = new Date(Date.UTC(y, m, d) - MSK_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1);
  const dayDateUtc = new Date(Date.UTC(y, m, d));
  return {
    date: formatMskDateParts(y, m, d),
    startUtc,
    endUtc,
    dayDateUtc,
  };
}

function dayDateUtcFromMskMidnight(mskMidnightUtc: Date): Date {
  // mskMidnightUtc — это UTC-момент полуночи MSK. Календарный день MSK
  // соответствует полуночи UTC «того же дня» (yyyy-mm-dd).
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const shifted = new Date(mskMidnightUtc.getTime() + MSK_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

function formatMskDate(d: Date): string {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const shifted = new Date(d.getTime() + MSK_OFFSET_MS);
  return formatMskDateParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
}

function formatMskDateParts(y: number, m0: number, d: number): string {
  const mm = String(m0 + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function buildEmptyHistoryDays(
  todayStartUtc: Date,
  days: number,
): MeHistoryDayDto[] {
  const out: MeHistoryDayDto[] = [];
  for (let i = 0; i < days; i++) {
    const ds = new Date(todayStartUtc);
    ds.setUTCDate(ds.getUTCDate() - i);
    out.push({
      date: formatMskDate(ds),
      pieceworkQty: 0,
      pieceworkAmount: 0,
      pieceworkApprovedAmount: 0,
      pieceworkPendingAmount: 0,
      salaryAmount: 0,
      total: 0,
      hasPending: false,
    });
  }
  return out;
}

function emptyDaily(date: string): MeDailyDto {
  return {
    date,
    compensationType: null,
    piecework: null,
    salary: null,
    total: 0,
  };
}

function toSharedCompType(
  type: PrismaCompensationType | null,
): SharedCompensationType | null {
  if (type === PrismaCompensationType.PIECEWORK) return 'PIECEWORK';
  if (type === PrismaCompensationType.SALARY) return 'SALARY';
  if (type === PrismaCompensationType.MIXED) return 'MIXED';
  return null;
}

function aggregatePieceworkRows(
  rows: Array<{
    qty: number;
    amount: Prisma.Decimal;
    status: EntryStatus;
    operation: { id: string; code: string; name: string };
  }>,
): MeDailyDto['piecework'] {
  const byOp = new Map<string, MeDailyOperationDto>();
  let totalQty = 0;
  let approvedAmount = 0;
  let pendingAmount = 0;
  for (const row of rows) {
    const amount = decimalToNumber(row.amount);
    const op = row.operation;
    const cell =
      byOp.get(op.id) ??
      ({
        operationId: op.id,
        operationCode: op.code,
        operationName: op.name,
        qty: 0,
        amount: 0,
        approvedAmount: 0,
        pendingAmount: 0,
      } satisfies MeDailyOperationDto);
    cell.qty += row.qty;
    cell.amount += amount;
    if (
      row.status === EntryStatus.PENDING_RELEASE ||
      row.status === EntryStatus.PENDING
    ) {
      cell.pendingAmount += amount;
      pendingAmount += amount;
    } else if (row.status === EntryStatus.APPROVED) {
      cell.approvedAmount += amount;
      approvedAmount += amount;
    }
    totalQty += row.qty;
    byOp.set(op.id, cell);
  }

  const byOperation = [...byOp.values()]
    .map((c) => ({
      ...c,
      amount: roundMoneyNumber(c.amount),
      approvedAmount: roundMoneyNumber(c.approvedAmount),
      pendingAmount: roundMoneyNumber(c.pendingAmount),
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    byOperation,
    totalQty,
    totalAmount: roundMoneyNumber(approvedAmount + pendingAmount),
    approvedAmount: roundMoneyNumber(approvedAmount),
    pendingAmount: roundMoneyNumber(pendingAmount),
  };
}

function decimalToNumber(value: Prisma.Decimal | null): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toFixed(2));
}

function decimalToNumberOrNull(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toFixed(2));
}

function roundMoneyNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
