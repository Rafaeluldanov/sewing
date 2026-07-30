import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CompensationType, Prisma, Role, SalaryRateMode } from '@prisma/client';
import type {
  ActiveCutterListItemDto,
  CreateEmployeeDto,
  EmployeeArchiveBlockerDto,
  EmployeeBlockersResponse,
  EmployeeDetailDto,
  EmployeeHardDeleteBlockerDto,
  EmployeeListItemDto,
  ListEmployeesQuery,
  UpdateEmployeeDto,
} from '@sewing/shared/employees';
import {
  areAllSystemRoles,
  expandRoleCodes,
} from '@sewing/shared/app-roles';
import { normalizeAssignedRoles } from '@sewing/shared/employees';
import type {
  BulkArchiveResultDto,
  BulkArchiveSkipDto,
} from '@sewing/shared/archive';
import { PrismaService } from '../../prisma/prisma.service.js';
import { describeBusinessError } from '../../common/bulk-archive.js';
import {
  CashFlowItemNotFoundException,
  CompanyDivisionInactiveException,
  CompanyDivisionNotFoundException,
  EmployeeAdminTargetForbiddenException,
  EmployeeArchiveBlockedException,
  EmployeeCannotModifySelfException,
  EmployeeRoleUnknownException,
  EmployeeDisplayCascadeAckRequiredException,
  EmployeeHasHistoryException,
  EmployeeLastAdminException,
  EmployeeLoginTakenException,
  EmployeeNotFoundException,
  EmployeeSalaryRateRequiredException,
} from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { requiresHourlyRate, requiresMonthlyRate } from './compensation.js';

/**
 * Сервис управления сотрудниками (post-Шаг 18 / Шаг 19, ADR-0021,
 * + post-задача «Добавить сотрудника» с UI на `/admin/employees/new`).
 *
 * Скоуп — read + management-поля (`compensationType`,
 * `salaryPerShift`, `active`), создание новой карточки
 * (`fullName`, `login`, `pinHash`, `role` и стартовая окладная
 * конфигурация), а также архивирование / восстановление / физическое
 * удаление (см. `docs/employee-deletion-recon.md`,
 * `archive` / `restore` / `hardDelete` ниже). Hard-delete доступен
 * только для свежих пустых карточек — контроль через `getBlockers`.
 *
 * PIN хранится только как bcrypt-hash в `Employee.pinHash`, наружу не
 * отдаётся ни одним DTO (см. `toListDto` / `toDetailDto`). Тот же
 * cost-factor (10), что и в `prisma/seed.ts`/`AuthService`.
 */
const PIN_HASH_COST = 10;

/**
 * Единый include для чтения карточки сотрудника. Кроме подразделения
 * подтягиваем привязанную статью ДДС для выплат
 * (`Employee.salaryCashFlowItem`) — её id/имя уходят в `EmployeeDetailDto`
 * (read-вид карточки + дефолт селекта в форме «Доступ»).
 */
const EMPLOYEE_DETAIL_INCLUDE = {
  companyDivision: true,
  salaryCashFlowItem: { select: { id: true, name: true } },
} as const satisfies Prisma.EmployeeInclude;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(query: ListEmployeesQuery): Promise<EmployeeListItemDto[]> {
    const where: Prisma.EmployeeWhereInput = {};
    if (query.active !== undefined) where.active = query.active;
    // Фича «несколько ролей»: фильтр «по роли» матчит набор доступа
    // (`roles has`), а не только основную роль — менеджер ищет всех,
    // кто умеет выполнять роль, включая совместителей.
    if (query.role) where.roles = { has: query.role as Role };
    if (query.compensationType) {
      where.compensationType = query.compensationType as CompensationType;
    }
    if (query.companyDivisionId) {
      where.companyDivisionId = query.companyDivisionId;
    }
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { login: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.employee.findMany({
      where,
      orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
      include: EMPLOYEE_DETAIL_INCLUDE,
    });
    return rows.map(toListDto);
  }

  async get(id: string): Promise<EmployeeDetailDto> {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      include: EMPLOYEE_DETAIL_INCLUDE,
    });
    if (!row) throw new EmployeeNotFoundException();
    return toDetailDto(row);
  }

  /**
   * Узкий read-only справочник активных раскройщиков для select-а
   * на форме выпуска паспорта (`apps/web/app/orders/[id]/passports/new`).
   *
   * Контракт фиксирован на уровне сервиса:
   *   - `where`: hard-coded `role = CUTTER` AND `active = true`
   *     (фильтр не приходит из query — endpoint узкий по дизайну);
   *   - `select`: только `id, fullName, login` — никаких payroll-полей
   *     (`salaryPerShift`, `compensationType`, `companyDivision`).
   *     Метод **не должен** делегироваться в `list()` или
   *     `toListDto()`: они расширяемы, и любой будущий field в
   *     `EmployeeListItemDto` автоматически утечёт через широкий DTO.
   *   - `orderBy`: `fullName ASC` для предсказуемого порядка в UI.
   *
   * RBAC контролируется на контроллере (`EmployeesController.listActiveCutters`,
   * `@Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')`). Подробнее —
   * `docs/cutter-assistant-passport-release-recon.md §5`.
   */
  async listActiveCutters(): Promise<ActiveCutterListItemDto[]> {
    return this.prisma.employee.findMany({
      where: { role: Role.CUTTER, active: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, login: true },
    });
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  /**
   * Создание новой карточки сотрудника. Используется со страницы
   * `/admin/employees/new` (см. `docs/screens.md §10d`).
   *
   * Инварианты:
   *   - `login` уникален (`Employee.login @unique`); конфликт
   *     транслируется в `EMPLOYEE_LOGIN_TAKEN` (409);
   *   - окладная тройка `(compensationType, salaryRateMode, ставка)`
   *     валидируется тем же правилом, что и в `update`: для
   *     `SALARY`/`MIXED` обязательна положительная ставка — почасовая
   *     при `HOURLY`, месячный оклад при `MONTHLY`. Это уже зеркалит
   *     `CreateEmployeeSchema.superRefine`, но мы дублируем guard на
   *     сервисе, чтобы не зависеть от того, что наружу однажды появится
   *     ещё один путь записи (например, импорт).
   *
   * `pinHash` всегда вычисляется из присланного `pin` через bcrypt
   * c тем же cost-factor (10), что и `prisma/seed.ts` — чтобы у нового
   * сотрудника логин работал ровно так же, как у seed-аккаунтов.
   */
  async create(dto: CreateEmployeeDto): Promise<EmployeeDetailDto> {
    const createRateMode = (dto.salaryRateMode ??
      SalaryRateMode.HOURLY) as SalaryRateMode;
    if (
      requiresHourlyRate(
        dto.compensationType as CompensationType,
        createRateMode,
      ) &&
      (dto.salaryPerHour === null ||
        dto.salaryPerHour === undefined ||
        dto.salaryPerHour <= 0)
    ) {
      throw new EmployeeSalaryRateRequiredException();
    }
    if (
      requiresMonthlyRate(
        dto.compensationType as CompensationType,
        createRateMode,
      ) &&
      (dto.salaryPerMonth === null ||
        dto.salaryPerMonth === undefined ||
        dto.salaryPerMonth <= 0)
    ) {
      throw new EmployeeSalaryRateRequiredException();
    }

    // PHASE 2 STEP 2: если менеджер при создании выбрал
    // подразделение — оно должно существовать и быть активным.
    // `null` / `undefined` означают «без привязки», менеджер
    // потом сделает выбор в `/admin/employees/[id]`.
    if (dto.companyDivisionId) {
      await this.assertCompanyDivisionUsable(dto.companyDivisionId);
    }

    // Статья ДДС для выплат: если задана — должна существовать (активность
    // не требуем — список селекта отдаёт только активные, но привязать
    // можно и ранее выбранную, позже деактивированную статью).
    if (dto.salaryCashFlowItemId) {
      await this.assertCashFlowItemExists(dto.salaryCashFlowItemId);
    }

    // Роль — ссылка на справочник (`AppRole.code`), а не enum: код
    // должен существовать, иначе сотрудник получит ноль прав молча.
    await this.assertRolesExist(normalizeAssignedRoles(dto.role, dto.roles));

    const pinHash = await bcrypt.hash(dto.pin, PIN_HASH_COST);

    let created;
    try {
      created = await this.prisma.employee.create({
        data: {
          fullName: dto.fullName,
          login: dto.login,
          pinHash,
          role: dto.role as Role,
          // Фича «несколько ролей»: набор доступа всегда содержит
          // основную роль (`normalizeAssignedRoles`). Если менеджер не
          // прислал доп. роли — получаем `[role]`, поведение прежнее.
          roles: normalizeAssignedRoles(dto.role, dto.roles) as Role[],
          compensationType: dto.compensationType as CompensationType,
          // Вид окладной ставки: часовая (по умолчанию) или месячная.
          salaryRateMode: createRateMode,
          // Повременная оплата: ставка режима `HOURLY`.
          salaryPerHour:
            dto.salaryPerHour === undefined || dto.salaryPerHour === null
              ? null
              : new Prisma.Decimal(dto.salaryPerHour.toFixed(2)),
          // Месячный оклад: ставка режима `MONTHLY`.
          salaryPerMonth:
            dto.salaryPerMonth === undefined || dto.salaryPerMonth === null
              ? null
              : new Prisma.Decimal(dto.salaryPerMonth.toFixed(2)),
          // LEGACY «за смену»: больше не участвует в расчёте, но если
          // значение всё же пришло (импорт/совместимость) — сохраняем.
          salaryPerShift:
            dto.salaryPerShift === undefined || dto.salaryPerShift === null
              ? null
              : new Prisma.Decimal(dto.salaryPerShift.toFixed(2)),
          // B2B-процент закройщика (см.
          // `docs/payroll-cutter-compensation-recon.md §«Настраиваемый
          // процент»`). Поле имеет смысл только для роли `CUTTER` —
          // UI скрывает его для остальных ролей. Здесь сервер не
          // делает role-guard: если значение пришло — сохраняем.
          // B2B-flow `EarningsService.createImmediateForCutter`
          // читает это поле уже после собственного role-фильтра.
          cutterB2bSewingPercent:
            dto.cutterB2bSewingPercent === undefined ||
            dto.cutterB2bSewingPercent === null
              ? null
              : new Prisma.Decimal(dto.cutterB2bSewingPercent.toFixed(2)),
          companyDivisionId: dto.companyDivisionId ?? null,
          // Статья ДДС для выплат зарплаты (переопределяет глобальную
          // `TreasurySettings.salaryItemId` в проводке по выплате).
          // `null` — не задана, проводка возьмёт глобальную статью.
          salaryCashFlowItemId: dto.salaryCashFlowItemId ?? null,
          active: dto.active ?? true,
        },
        include: EMPLOYEE_DETAIL_INCLUDE,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = (e.meta?.target as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        if (fields.some((f) => String(f).includes('login'))) {
          throw new EmployeeLoginTakenException();
        }
      }
      throw e;
    }

    this.logger.log(
      `event=employee.create id=${created.id} login=${created.login} role=${created.role} companyDivisionId=${created.companyDivisionId ?? 'null'}`,
    );
    return toDetailDto(created);
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  /**
   * Точечный patch management-полей. Инвариант ADR-0021:
   *   - `compensationType in (SALARY, MIXED)` ⇒ `salaryPerHour > 0`.
   *
   * Если patch ломает инвариант — бросаем `EMPLOYEE_SALARY_RATE_REQUIRED`.
   * Это ловится на UI и подсвечивается на форме ставки.
   */
  async update(
    id: string,
    dto: UpdateEmployeeDto,
    viewer: AuthPrincipal,
  ): Promise<EmployeeDetailDto> {
    const current = await this.prisma.employee.findUnique({ where: { id } });
    if (!current) throw new EmployeeNotFoundException();

    // -------------------------------------------------------------------------
    // Фича «несколько ролей»: смена основной роли и/или набора доступа.
    // -------------------------------------------------------------------------
    const wantsRoleChange = dto.role !== undefined || dto.roles !== undefined;
    let nextPrimary: Role | undefined;
    let nextRoles: Role[] | undefined;
    let roleChanged = false;
    if (wantsRoleChange) {
      nextPrimary = (dto.role ?? current.role) as Role;
      // Инвариант «набор содержит основную роль» держим централизованно.
      nextRoles = normalizeAssignedRoles(
        nextPrimary,
        dto.roles ?? (current.roles as Role[]),
      ) as Role[];
      await this.assertRolesExist(nextRoles);

      const currentRoles =
        current.roles && current.roles.length > 0
          ? (current.roles as Role[])
          : [current.role as Role];
      // No-op: форма всегда шлёт role+roles, но фактической смены может
      // не быть (менеджер правит только зарплату). Тогда не запускаем
      // RBAC/последний-админ и не пишем колонки — иначе SHOP_MANAGER не
      // смог бы сохранить даже compensation у ADMIN-карточки.
      roleChanged =
        nextPrimary !== current.role || !sameRoleSet(nextRoles, currentRoles);

      if (roleChanged) {
        // Справочник ролей: «админ» — это не только код ADMIN в наборе,
        // но и любая роль, которая ADMIN НАСЛЕДУЕТ. Иначе начальник цеха
        // выдал бы кастомную роль с `inherits: ['ADMIN']` и обошёл бы
        // запрет эскалации ниже. `viewer.roles` уже раскрыт `AuthGuard`-ом,
        // наборы сотрудника раскрываем здесь.
        const viewerIsAdmin = viewer.roles.includes(Role.ADMIN);
        const [targetIsAdmin, willBeAdmin] = await Promise.all([
          this.grantsAdmin(currentRoles),
          this.grantsAdmin(nextRoles),
        ]);

        // RBAC: только ADMIN управляет ADMIN-доступом — не-админ не может
        // ни трогать роли админа, ни выдать роль ADMIN кому-либо (защита
        // от эскалации привилегий начальником цеха).
        if (!viewerIsAdmin && (targetIsAdmin || willBeAdmin)) {
          throw new EmployeeAdminTargetForbiddenException();
        }

        // Защита последнего активного админа: нельзя снять ADMIN с
        // единственного оставшегося.
        if (targetIsAdmin && !willBeAdmin) {
          await this.assertNotLastActiveAdmin(id);
        }
      }
    }

    const next = {
      compensationType: dto.compensationType ?? current.compensationType,
      salaryRateMode: dto.salaryRateMode ?? current.salaryRateMode,
      salaryPerHour:
        dto.salaryPerHour !== undefined
          ? dto.salaryPerHour
          : current.salaryPerHour !== null
          ? Number(current.salaryPerHour)
          : null,
      salaryPerMonth:
        dto.salaryPerMonth !== undefined
          ? dto.salaryPerMonth
          : current.salaryPerMonth !== null
          ? Number(current.salaryPerMonth)
          : null,
      active: dto.active ?? current.active,
    };

    // Инвариант проверяем по ИТОГОВОЙ паре «тип компенсации + режим
    // ставки»: переключение режима — самый частый способ его сломать
    // (менеджер выбрал «месячный», а сумму оклада не ввёл, при этом
    // старая почасовая ставка в колонке ещё лежит и создаёт иллюзию
    // заполненности).
    if (
      requiresHourlyRate(next.compensationType, next.salaryRateMode) &&
      (next.salaryPerHour === null || next.salaryPerHour <= 0)
    ) {
      throw new EmployeeSalaryRateRequiredException();
    }
    if (
      requiresMonthlyRate(next.compensationType, next.salaryRateMode) &&
      (next.salaryPerMonth === null || next.salaryPerMonth <= 0)
    ) {
      throw new EmployeeSalaryRateRequiredException();
    }

    // PHASE 2 STEP 2: если менеджер сменил подразделение — должно
    // существовать и быть активным. `null` (стереть привязку) —
    // не валидируем; снять привязку всегда можно.
    if (dto.companyDivisionId !== undefined && dto.companyDivisionId !== null) {
      await this.assertCompanyDivisionUsable(dto.companyDivisionId);
    }

    // Статья ДДС для выплат: если менеджер выбрал статью — она должна
    // существовать. `null` (снять привязку) не валидируем.
    if (
      dto.salaryCashFlowItemId !== undefined &&
      dto.salaryCashFlowItemId !== null
    ) {
      await this.assertCashFlowItemExists(dto.salaryCashFlowItemId);
    }

    const data: Prisma.EmployeeUpdateInput = {};
    if (roleChanged && nextPrimary && nextRoles) {
      data.role = nextPrimary;
      data.roles = { set: nextRoles };
      // Если активная роль (последнее сканированное рабочее место)
      // больше не входит в набор — сбрасываем её, чтобы лендинг не
      // указывал на недоступный теперь экран.
      if (
        current.activeRole &&
        !nextRoles.includes(current.activeRole as Role)
      ) {
        data.activeRole = null;
      }
    }
    if (dto.compensationType !== undefined) {
      data.compensationType = dto.compensationType as CompensationType;
    }
    if (dto.salaryRateMode !== undefined) {
      data.salaryRateMode = dto.salaryRateMode as SalaryRateMode;
    }
    if (dto.salaryPerHour !== undefined) {
      data.salaryPerHour =
        dto.salaryPerHour === null
          ? null
          : new Prisma.Decimal(dto.salaryPerHour.toFixed(2));
    }
    if (dto.salaryPerMonth !== undefined) {
      data.salaryPerMonth =
        dto.salaryPerMonth === null
          ? null
          : new Prisma.Decimal(dto.salaryPerMonth.toFixed(2));
    }
    if (dto.salaryPerShift !== undefined) {
      // LEGACY: форма больше не шлёт это поле, но если пришло —
      // сохраняем (в расчёте зарплаты не участвует).
      data.salaryPerShift =
        dto.salaryPerShift === null
          ? null
          : new Prisma.Decimal(dto.salaryPerShift.toFixed(2));
    }
    if (dto.active !== undefined) {
      data.active = dto.active;
    }
    if (dto.cutterB2bSewingPercent !== undefined) {
      // `null` → стираем процент (backend возьмёт fallback из ENV
      // `CUTTER_B2B_SEWING_PERCENT`). `undefined` → не трогаем
      // колонку. Подробнее — `docs/payroll-cutter-compensation-recon.md`.
      data.cutterB2bSewingPercent =
        dto.cutterB2bSewingPercent === null
          ? null
          : new Prisma.Decimal(dto.cutterB2bSewingPercent.toFixed(2));
    }
    if (dto.companyDivisionId !== undefined) {
      // `null` — стереть привязку, иначе — переставить на другую
      // карточку. Используем nested-write через `connect`/`disconnect`,
      // чтобы Prisma корректно зачистила FK.
      data.companyDivision =
        dto.companyDivisionId === null
          ? { disconnect: true }
          : { connect: { id: dto.companyDivisionId } };
    }
    if (dto.salaryCashFlowItemId !== undefined) {
      // `null` — снять привязку (проводка по выплате возьмёт глобальную
      // статью из настроек казначейства), иначе — привязать выбранную.
      data.salaryCashFlowItem =
        dto.salaryCashFlowItemId === null
          ? { disconnect: true }
          : { connect: { id: dto.salaryCashFlowItemId } };
    }

    const updated = await this.prisma.employee.update({
      where: { id },
      data,
      include: EMPLOYEE_DETAIL_INCLUDE,
    });
    return toDetailDto(updated);
  }

  // ===========================================================================
  // ARCHIVE / RESTORE / HARD-DELETE (см. `docs/employee-deletion-recon.md`)
  // ===========================================================================

  /**
   * Превью «можно ли заархивировать или физически удалить» сотрудника.
   * Возвращает структуру с двумя списками блокеров:
   *
   *   - `archiveBlockers` — открытая активность (смена, висящие
   *     паспорта, открытые `MasterCall`, `REQUESTED`-заявки на
   *     закрытие раскроя). Пока есть хотя бы один — `archiveAllowed = false`.
   *   - `hardDeleteBlockers` — счётчики финансовой / производственной
   *     истории (`OperationEntry`, `SalaryEntry`, `Passport*`,
   *     `ShiftSession`, `Box`, `MasterCall`, `PassportDefect`,
   *     `PayrollPayout`, `PayrollAccrualDocumentLine`). Пока есть
   *     хотя бы один — `hardDeleteAllowed = false`.
   *
   * Backend пересчитывает то же самое при `POST /archive` /
   * `DELETE`, чтобы между preflight и операцией не проехал race —
   * этот endpoint только для UX.
   */
  async getBlockers(id: string): Promise<EmployeeBlockersResponse> {
    const exists = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!exists) throw new EmployeeNotFoundException();

    const [
      openShifts,
      currentPassports,
      openMasterCalls,
      openClosureRequests,
      operationEntries,
      salaryEntries,
      passportsAsCutter,
      passportsAsCreator,
      passportsAsCurrent,
      passportDefects,
      shiftSessions,
      boxes,
      masterCallsTotal,
      masterCallsResolved,
      payrollPayouts,
      payrollAccrualLines,
      displayScreen,
    ] = await Promise.all([
      this.prisma.shiftSession.count({
        where: { employeeId: id, endedAt: null },
      }),
      this.prisma.passport.count({
        where: { currentEmployeeId: id },
      }),
      this.prisma.masterCall.count({
        where: { employeeId: id, status: 'OPEN' },
      }),
      this.prisma.cuttingClosureRequest.count({
        where: { requestedByEmployeeId: id, status: 'REQUESTED' },
      }),
      this.prisma.operationEntry.count({ where: { employeeId: id } }),
      this.prisma.salaryEntry.count({ where: { employeeId: id } }),
      this.prisma.passport.count({ where: { cutterId: id } }),
      this.prisma.passport.count({ where: { creatorId: id } }),
      // Висящие паспорта (`currentEmployeeId`) попадают и в архив-,
      // и в hard-delete-блокеры. Для hard-delete считаем все — даже
      // если у сотрудника нет открытой смены, но паспорт привязан.
      this.prisma.passport.count({ where: { currentEmployeeId: id } }),
      this.prisma.passportDefect.count({ where: { createdByEmployeeId: id } }),
      this.prisma.shiftSession.count({ where: { employeeId: id } }),
      this.prisma.box.count({ where: { createdById: id } }),
      this.prisma.masterCall.count({ where: { employeeId: id } }),
      this.prisma.masterCall.count({ where: { resolvedById: id } }),
      this.prisma.payrollPayout.count({
        where: {
          OR: [
            { employeeId: id },
            { createdById: id },
            { issuedById: id },
            { acknowledgedByEmployeeId: id },
            { cancelledById: id },
          ],
        },
      }),
      this.prisma.payrollAccrualDocumentLine.count({
        where: { employeeId: id },
      }),
      this.prisma.displayScreenConfig.findUnique({
        where: { employeeId: id },
        select: { id: true },
      }),
    ]);

    const archiveBlockers: EmployeeArchiveBlockerDto[] = [];
    if (openShifts > 0)
      archiveBlockers.push({ kind: 'OPEN_SHIFT', count: openShifts });
    if (currentPassports > 0)
      archiveBlockers.push({
        kind: 'CURRENT_PASSPORTS',
        count: currentPassports,
      });
    if (openMasterCalls > 0)
      archiveBlockers.push({
        kind: 'OPEN_MASTER_CALLS',
        count: openMasterCalls,
      });
    if (openClosureRequests > 0)
      archiveBlockers.push({
        kind: 'OPEN_CLOSURE_REQUESTS',
        count: openClosureRequests,
      });

    // Все паспорта (cutter/creator/current) консолидируем в одну
    // строку UI — «N паспортов в истории». Внутри считаем сумму с
    // дедупликацией невозможной (один паспорт может быть и cutter,
    // и creator одновременно), но фактически нас интересует «есть
    // ли хоть что-то», а сумма даёт «масштаб» для оператора.
    const passportTotal =
      passportsAsCutter + passportsAsCreator + passportsAsCurrent;
    const masterCallsTotalForBlockers = masterCallsTotal + masterCallsResolved;

    const hardDeleteBlockers: EmployeeHardDeleteBlockerDto[] = [];
    if (operationEntries > 0)
      hardDeleteBlockers.push({
        kind: 'OperationEntry',
        count: operationEntries,
      });
    if (salaryEntries > 0)
      hardDeleteBlockers.push({ kind: 'SalaryEntry', count: salaryEntries });
    if (passportTotal > 0)
      hardDeleteBlockers.push({ kind: 'Passport', count: passportTotal });
    if (passportDefects > 0)
      hardDeleteBlockers.push({
        kind: 'PassportDefect',
        count: passportDefects,
      });
    if (shiftSessions > 0)
      hardDeleteBlockers.push({ kind: 'ShiftSession', count: shiftSessions });
    if (boxes > 0) hardDeleteBlockers.push({ kind: 'Box', count: boxes });
    if (masterCallsTotalForBlockers > 0)
      hardDeleteBlockers.push({
        kind: 'MasterCall',
        count: masterCallsTotalForBlockers,
      });
    if (payrollPayouts > 0)
      hardDeleteBlockers.push({ kind: 'PayrollPayout', count: payrollPayouts });
    if (payrollAccrualLines > 0)
      hardDeleteBlockers.push({
        kind: 'PayrollAccrualDocumentLine',
        count: payrollAccrualLines,
      });

    return {
      archiveAllowed: archiveBlockers.length === 0,
      hardDeleteAllowed: hardDeleteBlockers.length === 0,
      hasDisplayScreenConfig: !!displayScreen,
      archiveBlockers,
      hardDeleteBlockers,
    };
  }

  /**
   * Мягкое удаление: `active = false`. UI/`AuthService` режут логин
   * для archived карточек, но сама запись со всей историей остаётся
   * в БД. Reverse — `restore()`.
   *
   * Guards:
   *   - viewer !== target;
   *   - SHOP_MANAGER не может архивировать ADMIN-а;
   *   - нельзя архивировать последнего активного ADMIN-а;
   *   - blockers из `getBlockers().archiveBlockers` должны быть пусты
   *     (открытая смена / висящие паспорта / открытые MasterCall /
   *     REQUESTED-заявки на закрытие раскроя).
   *
   * Идемпотентно: если карточка уже архивная (`active = false`),
   * возвращается как есть (без аудита-noop, чтобы не зашумлять журнал).
   */
  async archive(id: string, viewer: AuthPrincipal): Promise<EmployeeDetailDto> {
    const target = await this.prisma.employee.findUnique({
      where: { id },
      include: EMPLOYEE_DETAIL_INCLUDE,
    });
    if (!target) throw new EmployeeNotFoundException();
    if (!target.active) return toDetailDto(target);

    await this.assertCanModifyTarget(target, viewer);

    if (await this.grantsAdmin(rolesOf(target))) {
      await this.assertNotLastActiveAdmin(target.id);
    }

    const blockers = await this.getBlockers(id);
    if (!blockers.archiveAllowed) {
      throw new EmployeeArchiveBlockedException();
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.employee.update({
        where: { id },
        data: { active: false },
        include: EMPLOYEE_DETAIL_INCLUDE,
      });
      await this.audit.log(
        {
          event: 'EMPLOYEE_ARCHIVED',
          entityType: 'EMPLOYEE',
          entityId: id,
          payload: {
            targetId: id,
            targetSnapshot: {
              fullName: target.fullName,
              login: target.login,
              role: target.role,
            },
          },
          employeeId: viewer.employeeId,
        },
        tx,
      );
      return row;
    });

    this.logger.log(
      `event=employee.archive id=${id} actor=${viewer.employeeId}`,
    );
    return toDetailDto(updated);
  }

  /**
   * Снять архив. `active = false → true`. Guards проще, чем у
   * `archive`/`hardDelete` — отказать может только конфликт
   * `login @unique` (если за время в архиве кто-то завёл сотрудника
   * с тем же login). На этот случай Prisma вернёт `P2002` —
   * пробрасываем как `EMPLOYEE_LOGIN_TAKEN`, чтобы UI подсказал
   * менеджеру вручную сменить login одному из них.
   *
   * Идемпотентно для уже активных карточек.
   */
  async restore(id: string, viewer: AuthPrincipal): Promise<EmployeeDetailDto> {
    const target = await this.prisma.employee.findUnique({
      where: { id },
      include: EMPLOYEE_DETAIL_INCLUDE,
    });
    if (!target) throw new EmployeeNotFoundException();
    if (target.active) return toDetailDto(target);

    // Управление ADMIN-учётками — только из-под ADMIN'а, как и archive.
    await this.assertCanModifyTarget(target, viewer);

    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.employee.update({
          where: { id },
          data: { active: true },
          include: EMPLOYEE_DETAIL_INCLUDE,
        });
        await this.audit.log(
          {
            event: 'EMPLOYEE_RESTORED',
            entityType: 'EMPLOYEE',
            entityId: id,
            payload: { targetId: id },
            employeeId: viewer.employeeId,
          },
          tx,
        );
        return row;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // На случай теоретического конфликта на login при включении
        // (если когда-нибудь логика поменяется и login начнут
        // суффиксовать при архиве). Сейчас в коде такого нет, но
        // защита copy-paste-safe.
        const target = (e.meta?.target as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        if (fields.some((f) => String(f).includes('login'))) {
          throw new EmployeeLoginTakenException();
        }
      }
      throw e;
    }

    this.logger.log(
      `event=employee.restore id=${id} actor=${viewer.employeeId}`,
    );
    return toDetailDto(updated);
  }

  /**
   * Физическое удаление карточки. Только для свежесозданных пустых
   * учёток: проверяем, что нет никакой финансовой / производственной
   * истории. Полный список блокеров — `getBlockers().hardDeleteBlockers`.
   *
   * Guards:
   *   - viewer.role === ADMIN (метод-уровневый RBAC);
   *   - viewer !== target;
   *   - target.role !== ADMIN || есть другой активный ADMIN;
   *   - target.role !== DISPLAY || `ackDisplayCascade === true`
   *     (так как `DisplayScreenConfig.employeeId @onDelete: Cascade`
   *     каскадно снесёт привязанный экран);
   *   - все blockers из `getBlockers` === 0.
   *
   * После DELETE строка пропадает из БД; в `AuditLog` остаётся снимок
   * (`targetSnapshot`), чтобы расследование «куда делась учётка» имело
   * за что зацепиться.
   */
  async hardDelete(
    id: string,
    viewer: AuthPrincipal,
    opts: { ackDisplayCascade?: boolean } = {},
  ): Promise<void> {
    const target = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        login: true,
        role: true,
        roles: true,
        createdAt: true,
        active: true,
      },
    });
    if (!target) throw new EmployeeNotFoundException();

    if (viewer.employeeId === target.id) {
      throw new EmployeeCannotModifySelfException();
    }
    if (await this.grantsAdmin(rolesOf(target))) {
      await this.assertNotLastActiveAdmin(target.id);
    }

    const blockers = await this.getBlockers(id);
    if (!blockers.hardDeleteAllowed) {
      throw new EmployeeHasHistoryException();
    }
    if (blockers.hasDisplayScreenConfig && !opts.ackDisplayCascade) {
      throw new EmployeeDisplayCascadeAckRequiredException();
    }

    await this.prisma.$transaction(async (tx) => {
      // Аудит ДО delete: после `employee.delete` мы не сможем
      // привязать `employeeId` к строке журнала, если viewer удалил
      // сам себя (этого мы выше уже не допустили), но порядок всё
      // равно безопаснее «сначала зафиксировать, потом удалить».
      await this.audit.log(
        {
          event: 'EMPLOYEE_DELETED',
          entityType: 'EMPLOYEE',
          entityId: id,
          payload: {
            targetSnapshot: {
              fullName: target.fullName,
              login: target.login,
              role: target.role,
              createdAt: target.createdAt.toISOString(),
            },
            hadActiveDisplayConfig: blockers.hasDisplayScreenConfig,
          },
          employeeId: viewer.employeeId,
        },
        tx,
      );
      await tx.employee.delete({ where: { id } });
    });

    this.logger.log(
      `event=employee.delete id=${id} actor=${viewer.employeeId} login=${target.login} role=${target.role}`,
    );
  }

  // ===========================================================================
  // АРХИВ СОТРУДНИКОВ — bulk archive / restore / purge
  // ===========================================================================
  //
  // Общий контур справочников админки (`@sewing/shared/archive`) для
  // списка `/admin/employees`. Здесь он НЕ повторяет логику, а
  // оборачивает уже существующие одиночные `archive` / `restore` /
  // `hardDelete`: там живут все гейты раздела (нельзя на себе, нельзя
  // последнего админа, нельзя архивировать с открытой сменой, нельзя
  // удалить с историей). Дублировать их — гарантированно разъехаться.
  //
  // Цена — цикл вместо `updateMany`: на десятках сотрудников это
  // несущественно, а поведение остаётся ровно тем же, что и у кнопок
  // на карточке.

  /** Перевод доменного исключения раздела в причину пропуска. */
  private toArchiveSkip(id: string, e: unknown): BulkArchiveSkipDto {
    if (e instanceof EmployeeNotFoundException) {
      return { id, reason: 'NOT_FOUND' };
    }
    if (
      e instanceof EmployeeArchiveBlockedException ||
      e instanceof EmployeeHasHistoryException
    ) {
      return { id, reason: 'IN_USE', detail: describeBusinessError(e) };
    }
    if (
      e instanceof EmployeeCannotModifySelfException ||
      e instanceof EmployeeLastAdminException ||
      e instanceof EmployeeAdminTargetForbiddenException ||
      e instanceof EmployeeDisplayCascadeAckRequiredException
    ) {
      return { id, reason: 'FORBIDDEN', detail: describeBusinessError(e) };
    }
    throw e;
  }

  async archiveMany(
    ids: string[],
    viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    const processed: string[] = [];
    const skipped: BulkArchiveSkipDto[] = [];
    for (const id of Array.from(new Set(ids))) {
      try {
        await this.archive(id, viewer);
        processed.push(id);
      } catch (e) {
        skipped.push(this.toArchiveSkip(id, e));
      }
    }
    this.logger.log(
      `event=employee.archive.bulk processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  async restoreMany(
    ids: string[],
    viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    const processed: string[] = [];
    const skipped: BulkArchiveSkipDto[] = [];
    for (const id of Array.from(new Set(ids))) {
      try {
        await this.restore(id, viewer);
        processed.push(id);
      } catch (e) {
        skipped.push(this.toArchiveSkip(id, e));
      }
    }
    this.logger.log(
      `event=employee.restore.bulk processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  /**
   * Безвозвратное удаление учёток из архива.
   *
   * Дополнительно к гейтам `hardDelete` требуем, чтобы учётка была
   * архивной: со списка легко промахнуться мимо строки, поэтому
   * массовый путь строже одиночной кнопки на карточке (там ADMIN
   * подтверждает удаление вводом логина).
   *
   * `ackDisplayCascade` НЕ проставляем: если к сотруднику привязан
   * экран цеха, удаление снесло бы его каскадом. Такие пропускаем с
   * пояснением — экран убирается в своём разделе.
   */
  async purgeMany(
    ids: string[],
    viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    const processed: string[] = [];
    const skipped: BulkArchiveSkipDto[] = [];
    for (const id of Array.from(new Set(ids))) {
      try {
        const target = await this.prisma.employee.findUnique({
          where: { id },
          select: { id: true, active: true },
        });
        if (!target) {
          skipped.push({ id, reason: 'NOT_FOUND' });
          continue;
        }
        if (target.active) {
          skipped.push({ id, reason: 'NOT_ARCHIVED' });
          continue;
        }
        await this.hardDelete(id, viewer);
        processed.push(id);
      } catch (e) {
        skipped.push(this.toArchiveSkip(id, e));
      }
    }
    this.logger.log(
      `event=employee.purge.bulk processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  /**
   * Общие guards для archive/restore/hard-delete:
   *   - нельзя выполнять действие на самом себе;
   *   - SHOP_MANAGER не может управлять ADMIN-учётками.
   *
   * Для hard-delete также требуется `viewer.role === ADMIN`, но эта
   * проверка делается на уровне контроллера (`@Roles('ADMIN')` на
   * методе), а не здесь — `EmployeesController` уже знает viewer.role.
   */
  private async assertCanModifyTarget(
    target: { id: string; role: string; roles?: string[] },
    viewer: AuthPrincipal,
  ): Promise<void> {
    if (viewer.employeeId === target.id) {
      throw new EmployeeCannotModifySelfException();
    }
    // Фича «несколько ролей»: «админ» — это любой, у кого ADMIN в
    // наборе ролей (а не только основная роль). И viewer тоже «админ»,
    // если ADMIN среди его ролей.
    //
    // Справочник ролей: набор сотрудника раскрываем — админом делает и
    // кастомная роль, которая ADMIN наследует.
    const targetRoles =
      target.roles && target.roles.length > 0 ? target.roles : [target.role];
    if (
      (await this.grantsAdmin(targetRoles)) &&
      !viewer.roles.includes(Role.ADMIN)
    ) {
      throw new EmployeeAdminTargetForbiddenException();
    }
  }

  /**
   * Даёт ли набор ролей права ADMIN — с учётом наследования
   * (`AppRole.inherits`). Прямой код ADMIN отвечает без запроса; набор
   * только из системных ролей тоже: системные роли ничего не наследуют.
   */
  private async grantsAdmin(codes: readonly string[]): Promise<boolean> {
    if (codes.includes(Role.ADMIN)) return true;
    if (areAllSystemRoles(codes)) return false;
    const catalog = await this.prisma.appRole.findMany({
      select: { code: true, inherits: true },
    });
    return expandRoleCodes(codes, catalog).includes(Role.ADMIN);
  }

  /**
   * Запрещает архивирование / удаление / снятие роли у последнего
   * активного ADMIN. Передаём `excludeId` — чтобы при операции над
   * текущим ADMIN-ом считать «остальных» (без него).
   *
   * «Админ» считается по ЭФФЕКТИВНОМУ набору: и прямой код ADMIN в
   * `roles`, и кастомная роль, которая ADMIN наследует. Иначе счёт
   * занижался бы, и последний фактический админ ушёл бы в архив без
   * возражений — систему стало бы некому администрировать.
   *
   * Считаем в памяти: `roles` — Postgres-массив кодов, и «раскрой
   * наследование» в SQL не выразить. Активных сотрудников сотни,
   * а метод срабатывает только при операции над админом.
   */
  private async assertNotLastActiveAdmin(excludeId: string): Promise<void> {
    const others = await this.prisma.employee.findMany({
      where: { active: true, NOT: { id: excludeId } },
      select: { role: true, roles: true },
    });
    // Быстрый путь: прямой ADMIN нашёлся — раскрывать нечего.
    const codes = others.map((e) => (e.roles.length > 0 ? e.roles : [e.role]));
    if (codes.some((set) => set.includes(Role.ADMIN))) return;

    const custom = codes.filter((set) => !areAllSystemRoles(set));
    if (custom.length > 0) {
      const catalog = await this.prisma.appRole.findMany({
        select: { code: true, inherits: true },
      });
      if (
        custom.some((set) => expandRoleCodes(set, catalog).includes(Role.ADMIN))
      ) {
        return;
      }
    }
    throw new EmployeeLastAdminException();
  }

  // ===========================================================================
  // helpers
  // ===========================================================================

  /**
   * PHASE 2 STEP 2: гард для `Employee.companyDivisionId` в create/update.
   *
   * Карточка должна существовать (`COMPANY_DIVISION_NOT_FOUND`) и быть
   * активной (`COMPANY_DIVISION_INACTIVE`). Снять привязку (`null`)
   * можно всегда; этот метод вызывается только когда DTO принёс
   * непустой `companyDivisionId`.
   */
  private async assertCompanyDivisionUsable(divisionId: string): Promise<void> {
    const div = await this.prisma.companyDivision.findUnique({
      where: { id: divisionId },
      select: { id: true, isActive: true },
    });
    if (!div) throw new CompanyDivisionNotFoundException();
    if (!div.isActive) throw new CompanyDivisionInactiveException();
  }

  /**
   * Гард для `Employee.salaryCashFlowItemId` в create/update: выбранная
   * статья ДДС должна существовать (`CASH_FLOW_ITEM_NOT_FOUND`).
   * Активность НЕ требуем — менеджер мог привязать статью, которую
   * позже деактивировали; форсировать смену при правке карточки не
   * нужно (та же логика, что у `Supplier.defaultCashFlowItemId`).
   * Снять привязку (`null`) всегда можно — этот метод вызывается только
   * для непустого id.
   */
  /**
   * Все коды ролей существуют в справочнике (`AppRole`).
   *
   * АРХИВНЫЕ роли проходят проверку сознательно: `update` присылает
   * ВЕСЬ набор сотрудника, и если одну из его ролей успели убрать в
   * архив, отказ заблокировал бы правку зарплаты или подразделения —
   * менеджер оказался бы в тупике. Не предлагать архивную роль для
   * НОВОГО назначения — задача UI (селекты фильтруют `active`).
   */
  private async assertRolesExist(codes: readonly string[]): Promise<void> {
    const wanted = Array.from(new Set(codes.filter((c) => c)));
    if (wanted.length === 0) return;
    const known = await this.prisma.appRole.findMany({
      where: { code: { in: wanted } },
      select: { code: true },
    });
    const knownSet = new Set(known.map((r) => r.code));
    const unknown = wanted.filter((c) => !knownSet.has(c));
    if (unknown.length > 0) throw new EmployeeRoleUnknownException(unknown);
  }

  private async assertCashFlowItemExists(itemId: string): Promise<void> {
    const row = await this.prisma.cashFlowItem.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!row) throw new CashFlowItemNotFoundException();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type EmployeeRow = Prisma.EmployeeGetPayload<{
  include: typeof EMPLOYEE_DETAIL_INCLUDE;
}>;

/**
 * «Сотрудник является администратором» — фича «несколько ролей»:
 * ADMIN может быть как основной ролью, так и одной из ролей доступа.
 * Учитываем оба места (с fallback на основную роль, если набор пуст —
 * старые строки).
 */
/**
 * Роли сотрудника как набор кодов. ИНВАРИАНТ «roles содержит role»
 * держит `normalizeAssignedRoles`, но на старых строках `roles` мог
 * остаться пустым — тогда единственная роль лежит в `role`.
 *
 * Раскрытие наследования здесь НЕ делается: это чистая функция, а
 * каталог живёт в БД. Кому нужен эффективный набор — зовёт
 * `EmployeesService.grantsAdmin` / `AppRolesService.expand`.
 */
function rolesOf(e: { role: string; roles?: string[] | null }): string[] {
  return e.roles && e.roles.length > 0 ? e.roles : [e.role];
}

/** Сравнение двух наборов ролей как множеств (порядок не важен). */
function sameRoleSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set<string>(b);
  return a.every((r) => sb.has(r));
}

function toListDto(e: EmployeeRow): EmployeeListItemDto {
  return {
    id: e.id,
    fullName: e.fullName,
    login: e.login,
    role: e.role,
    // ИНВАРИАНТ «roles содержит role»: для старых строк с пустым
    // набором отдаём `[role]`, чтобы UI/RBAC всегда видели роль.
    roles: e.roles && e.roles.length > 0 ? e.roles : [e.role],
    activeRole: e.activeRole ?? null,
    compensationType: e.compensationType,
    salaryRateMode: e.salaryRateMode,
    salaryPerHour: e.salaryPerHour === null ? null : Number(e.salaryPerHour),
    salaryPerMonth: e.salaryPerMonth === null ? null : Number(e.salaryPerMonth),
    salaryPerShift: e.salaryPerShift === null ? null : Number(e.salaryPerShift),
    active: e.active,
    createdAt: e.createdAt.toISOString(),
    companyDivisionId: e.companyDivisionId,
    companyDivision: e.companyDivision
      ? {
          id: e.companyDivision.id,
          code: e.companyDivision.code,
          name: e.companyDivision.name,
        }
      : null,
  };
}

function toDetailDto(e: EmployeeRow): EmployeeDetailDto {
  return {
    ...toListDto(e),
    cutterB2bSewingPercent:
      e.cutterB2bSewingPercent === null
        ? null
        : Number(e.cutterB2bSewingPercent),
    salaryCashFlowItemId: e.salaryCashFlowItemId,
    salaryCashFlowItemName: e.salaryCashFlowItem?.name ?? null,
  };
}
