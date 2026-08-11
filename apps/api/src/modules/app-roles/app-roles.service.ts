import { Injectable, Logger } from '@nestjs/common';
import {
  SYSTEM_ROLE_CODES,
  SYSTEM_ROLE_DEFAULTS,
  areAllSystemRoles,
  expandRoleCodes,
  findInheritanceCycle,
  isSystemRoleCode,
  resolveRoleWorkspace,
  type AppRoleDto,
  type CreateAppRoleDto,
  type RoleWorkspaceResolution,
  type UpdateAppRoleDto,
} from '@sewing/shared/app-roles';
import type { BulkArchiveResultDto } from '@sewing/shared/archive';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { indexById, runBulkArchive } from '../../common/bulk-archive.js';
import {
  AppRoleCodeTakenException,
  AppRoleInheritanceCycleException,
  AppRoleNotFoundException,
  AppRoleSystemImmutableException,
  AppRoleUnknownParentException,
} from '../../common/errors.js';

/**
 * Нейтральное «рабочее окно»: полная навигация, никаких редиректов.
 * Отдаётся совместителям (2+ ролей) и учёткам без ролей.
 */
const NO_WORKSPACE: RoleWorkspaceResolution = {
  workspace: '/',
  singleWorkspace: false,
  lockToWorkspace: false,
};

/**
 * Рабочее окно для набора ТОЛЬКО системных ролей — из зашитых
 * дефолтов, без похода в БД. Правило то же, что у
 * `resolveRoleWorkspace`: «одно окно» — это про ровно одну роль.
 */
function systemWorkspace(codes: readonly string[]): RoleWorkspaceResolution {
  if (codes.length !== 1) return NO_WORKSPACE;
  const code = codes[0]!;
  if (!isSystemRoleCode(code)) return NO_WORKSPACE;
  const d = SYSTEM_ROLE_DEFAULTS[code];
  return {
    workspace: d.workspace,
    singleWorkspace: d.singleWorkspace,
    lockToWorkspace: d.lockToWorkspace,
  };
}

/**
 * Сервис справочника ролей (`AppRole`, `/admin/roles`).
 *
 * Две зоны ответственности:
 *
 *   1) CRUD + архив справочника — обычная админская работа
 *      (`list` / `create` / `update` / `archiveMany` / …);
 *   2) РАСКРЫТИЕ НАСЛЕДОВАНИЯ (`expand`) — то, ради чего всё затевалось.
 *      Им пользуется `AuthService.resolvePrincipal` на КАЖДОМ запросе,
 *      поэтому горячий путь оптимизирован: если все роли сотрудника
 *      системные (подавляющее большинство учёток), в БД не ходим вовсе.
 *
 * ПОЧЕМУ БЕЗ КЭША. Соблазн закэшировать каталог в памяти велик, но
 * приложение мультитенантное: `PrismaService` резолвит клиента по
 * тенанту запроса, и процессный кэш пришлось бы ключевать тенантом и
 * инвалидировать на запись — три способа получить «права из чужого
 * тенанта» и «правка роли не применилась». Таблица крошечная (десятки
 * строк), запрос точечный и только для учёток с кастомными ролями.
 */
@Injectable()
export class AppRolesService {
  private readonly logger = new Logger(AppRolesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // РАСКРЫТИЕ НАСЛЕДОВАНИЯ (горячий путь авторизации)
  // ===========================================================================

  /**
   * Эффективный набор ролей: сами роли + всё, что они наследуют
   * (транзитивно). Результат идёт в `AuthPrincipal.roles`, и по нему
   * `AuthGuard` сверяет `@Roles(...)`.
   *
   * Архивные роли раскрываются наравне с активными: архив прячет роль
   * из назначения, но не отбирает доступ у тех, кому она уже выдана
   * (иначе архивация молча выключала бы живых людей посреди смены).
   */
  async expand(codes: readonly string[]): Promise<string[]> {
    return (await this.resolveAccess(codes)).effective;
  }

  /**
   * Название роли для показа сотруднику (бейдж активного участка в
   * шапке терминала, `/api/auth/me`). У системных ролей название зашито
   * в `SYSTEM_ROLE_DEFAULTS` — в БД не ходим: это горячий путь, а почти
   * все учётки цеха системные. Неизвестный код возвращаем как есть.
   */
  async labelFor(code: string | null | undefined): Promise<string | undefined> {
    if (!code) return undefined;
    if (isSystemRoleCode(code)) return SYSTEM_ROLE_DEFAULTS[code].name;
    const row = await this.prisma.appRole.findUnique({
      where: { code },
      select: { name: true },
    });
    return row?.name ?? code;
  }

  /**
   * Рабочий экран сотрудника по его ИСХОДНОМУ набору ролей (см.
   * `resolveRoleWorkspace` — считается до раскрытия наследования).
   * Отдаётся в `/api/auth/me` и кладётся в session-cookie, чтобы
   * web-middleware и layout не гадали по захардкоженным спискам.
   */
  async resolveWorkspace(
    codes: readonly string[],
  ): Promise<RoleWorkspaceResolution> {
    return (await this.resolveAccess(codes)).workspace;
  }

  /**
   * Всё, что авторизации нужно знать о наборе ролей, ЗА ОДИН заход в
   * справочник: эффективный набор (`effective`) и рабочий экран
   * (`workspace`). Отдельные `expand` + `resolveWorkspace` дали бы два
   * запроса на КАЖДЫЙ запрос к API — именно поэтому метод общий.
   *
   * У учётки только с системными ролями (это почти все) запросов в БД
   * не делается вовсе: системные роли ничего не наследуют, а их экран
   * зашит в `SYSTEM_ROLE_DEFAULTS`.
   */
  async resolveAccess(codes: readonly string[]): Promise<{
    effective: string[];
    workspace: RoleWorkspaceResolution;
  }> {
    if (codes.length === 0) {
      return { effective: [], workspace: NO_WORKSPACE };
    }
    if (areAllSystemRoles(codes)) {
      return {
        effective: [...codes],
        workspace: systemWorkspace(codes),
      };
    }
    const catalog = await this.prisma.appRole.findMany({
      select: {
        code: true,
        inherits: true,
        workspace: true,
        singleWorkspace: true,
        lockToWorkspace: true,
      },
    });
    return {
      effective: expandRoleCodes(codes, catalog),
      // Системные строки в справочнике есть (их сидирует миграция),
      // поэтому смешанный набор «системная + кастомная» тоже резолвится
      // из каталога — отдельная ветка не нужна.
      workspace: resolveRoleWorkspace(codes, catalog),
    };
  }

  // ===========================================================================
  // READ
  // ===========================================================================

  /**
   * Полный листинг для `/admin/roles` — и активные, и архивные: вкладки
   * делит фронт (как в `/admin/display-screens`). Ролей десятки,
   * пагинация преждевременна.
   *
   * `employeeCount` считаем одним `groupBy` по `Employee.roles`… точнее,
   * не можем: Postgres-массив по `groupBy` не разложить. Поэтому берём
   * пары (id, roles) активных сотрудников и считаем в памяти — это
   * сотни строк, дешевле любого сложного SQL.
   */
  async list(): Promise<AppRoleDto[]> {
    const [rows, employees] = await Promise.all([
      this.prisma.appRole.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.employee.findMany({ select: { role: true, roles: true } }),
    ]);

    const counts = new Map<string, number>();
    for (const e of employees) {
      // Инвариант «roles содержит role» держится в `EmployeesService`,
      // но на старых строках `roles` мог остаться пустым — тогда
      // единственная роль сотрудника лежит в `role`.
      const own = e.roles.length > 0 ? e.roles : [e.role];
      for (const code of new Set(own)) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }

    return rows.map((r) => this.toDto(r, counts.get(r.code) ?? 0));
  }

  async getById(id: string): Promise<AppRoleDto> {
    const row = await this.prisma.appRole.findUnique({ where: { id } });
    if (!row) throw new AppRoleNotFoundException();
    return this.toDto(row, await this.countEmployees(row.code));
  }

  // ===========================================================================
  // WRITE
  // ===========================================================================

  /**
   * Завести кастомную роль. `system` наружу не выставляется никогда —
   * системные строки создаёт только миграция.
   */
  async create(dto: CreateAppRoleDto, actorId: string): Promise<AppRoleDto> {
    const code = dto.code;
    const existing = await this.prisma.appRole.findUnique({ where: { code } });
    if (existing) throw new AppRoleCodeTakenException(code);

    const inherits = await this.validateInherits(code, dto.inherits ?? []);

    // Кастомные роли живут после системных: системные заняли 10..120.
    const last = await this.prisma.appRole.aggregate({
      _max: { sortOrder: true },
    });
    const sortOrder = Math.max(last._max.sortOrder ?? 0, 999) + 1;

    const row = await this.prisma.appRole.create({
      data: {
        code,
        name: dto.name,
        system: false,
        inherits,
        workspace: dto.workspace ?? '/',
        // «Запереть на экране» без «одного окна» бессмысленно: заперли
        // бы на странице, вокруг которой рисуется полная навигация.
        singleWorkspace: dto.lockToWorkspace || (dto.singleWorkspace ?? false),
        lockToWorkspace: dto.lockToWorkspace ?? false,
        sortOrder,
      },
    });

    await this.audit.log({
      event: 'APP_ROLE_CREATE',
      entityType: 'APP_ROLE',
      entityId: row.id,
      employeeId: actorId,
      payload: { code: row.code, name: row.name, inherits: row.inherits },
    });
    this.logger.log(`Создана роль ${row.code} (наследует: ${inherits.join(', ') || '—'})`);
    return this.toDto(row, 0);
  }

  /**
   * Правка роли. Код не меняется никогда (он уже записан в
   * `Employee.roles` и в выданные cookie), у системных ролей правится
   * ТОЛЬКО название — структура (наследование, рабочий экран) зашита в
   * коде приложения и обязана совпадать с ним.
   */
  async update(
    id: string,
    dto: UpdateAppRoleDto,
    actorId: string,
  ): Promise<AppRoleDto> {
    const row = await this.prisma.appRole.findUnique({ where: { id } });
    if (!row) throw new AppRoleNotFoundException();

    const touchesStructure =
      dto.inherits !== undefined ||
      dto.workspace !== undefined ||
      dto.singleWorkspace !== undefined ||
      dto.lockToWorkspace !== undefined;
    if (row.system && touchesStructure) {
      throw new AppRoleSystemImmutableException(
        'У системной роли можно изменить только название — её права и рабочий экран заданы в коде приложения.',
      );
    }

    const inherits =
      dto.inherits === undefined
        ? undefined
        : await this.validateInherits(row.code, dto.inherits, id);

    const lockToWorkspace = dto.lockToWorkspace ?? row.lockToWorkspace;
    const singleWorkspace = dto.singleWorkspace ?? row.singleWorkspace;

    const updated = await this.prisma.appRole.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        inherits,
        workspace: dto.workspace ?? undefined,
        singleWorkspace: lockToWorkspace || singleWorkspace,
        lockToWorkspace,
      },
    });

    await this.audit.log({
      event: 'APP_ROLE_UPDATE',
      entityType: 'APP_ROLE',
      entityId: id,
      employeeId: actorId,
      payload: {
        code: updated.code,
        name: updated.name,
        inherits: updated.inherits,
      },
    });
    return this.toDto(updated, await this.countEmployees(updated.code));
  }

  // ===========================================================================
  // АРХИВ (контракт `@sewing/shared/archive`)
  // ===========================================================================

  /**
   * В архив. Системную роль архивировать нельзя: приложение опирается
   * на её код, «выключить» её означало бы спрятать из назначения роль,
   * которую сам код продолжает требовать.
   *
   * Роль с сотрудниками архивировать МОЖНО — доступ у них сохраняется
   * (см. `expand`), роль просто перестаёт предлагаться в формах. Это
   * нормальный сценарий вывода роли из обращения.
   */
  archiveMany(ids: string[], actorId: string): Promise<BulkArchiveResultDto> {
    return runBulkArchive({
      ids,
      load: (batch) => this.loadByIds(batch),
      alreadyDone: (r) => !r.active,
      gate: (r) =>
        r.system
          ? {
              reason: 'FORBIDDEN' as const,
              detail: `«${r.name}» — системная роль, её нельзя убрать в архив`,
            }
          : null,
      apply: async (_rows, targetIds) => {
        await this.prisma.appRole.updateMany({
          where: { id: { in: targetIds } },
          data: { active: false },
        });
        await this.audit.log({
          event: 'APP_ROLE_ARCHIVE',
          entityType: 'APP_ROLE',
          entityId: targetIds.join(','),
          employeeId: actorId,
          payload: { ids: targetIds, count: targetIds.length },
        });
      },
    });
  }

  restoreMany(ids: string[], actorId: string): Promise<BulkArchiveResultDto> {
    return runBulkArchive({
      ids,
      load: (batch) => this.loadByIds(batch),
      alreadyDone: (r) => r.active,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        await this.prisma.appRole.updateMany({
          where: { id: { in: targetIds } },
          data: { active: true },
        });
        await this.audit.log({
          event: 'APP_ROLE_RESTORE',
          entityType: 'APP_ROLE',
          entityId: targetIds.join(','),
          employeeId: actorId,
          payload: { ids: targetIds, count: targetIds.length },
        });
      },
    });
  }

  /**
   * Удалить навсегда — только из архива и только если роль никому не
   * выдана и её никто не наследует.
   *
   * FK на `Employee.role` нет сознательно (см. схему), поэтому оба
   * гейта — наши: без них удаление роли оставило бы сотрудника с кодом,
   * которого нет в справочнике (доступ пропадёт, а причина будет
   * невидима), а роль-наследника — с висячей ссылкой в `inherits`.
   */
  purgeMany(ids: string[], actorId: string): Promise<BulkArchiveResultDto> {
    return runBulkArchive({
      ids,
      load: (batch) => this.loadByIds(batch),
      gate: async (r) => {
        if (r.system) {
          return {
            reason: 'FORBIDDEN' as const,
            detail: `«${r.name}» — системная роль, её нельзя удалить`,
          };
        }
        if (r.active) return { reason: 'NOT_ARCHIVED' as const };

        const employees = await this.countEmployees(r.code);
        if (employees > 0) {
          return {
            reason: 'IN_USE' as const,
            detail: `«${r.name}» назначена сотрудникам: ${employees}`,
          };
        }
        const children = await this.prisma.appRole.findMany({
          where: { inherits: { has: r.code } },
          select: { name: true },
        });
        if (children.length > 0) {
          return {
            reason: 'IN_USE' as const,
            detail: `«${r.name}» наследуют роли: ${children
              .map((c) => c.name)
              .join(', ')}`,
          };
        }
        return null;
      },
      apply: async (_rows, targetIds) => {
        await this.prisma.appRole.deleteMany({ where: { id: { in: targetIds } } });
        await this.audit.log({
          event: 'APP_ROLE_PURGE',
          entityType: 'APP_ROLE',
          entityId: targetIds.join(','),
          employeeId: actorId,
          payload: { ids: targetIds, count: targetIds.length },
        });
      },
    });
  }

  // ===========================================================================
  // ВНУТРЕННЕЕ
  // ===========================================================================

  private async loadByIds(ids: string[]) {
    return indexById(
      await this.prisma.appRole.findMany({ where: { id: { in: ids } } }),
    );
  }

  /**
   * Сколько сотрудников имеет роль. Считаем и по `roles` (набор
   * доступа), и по `role` (основная) — на старых строках `roles` мог
   * остаться пустым, и учитывать только его значило бы «удалить роль,
   * которая на самом деле у кого-то основная».
   */
  private async countEmployees(code: string): Promise<number> {
    return this.prisma.employee.count({
      where: { OR: [{ roles: { has: code } }, { role: code }] },
    });
  }

  /**
   * Проверяет список наследуемых кодов: дедуп, «сама себя не
   * наследует», все коды существуют, циклов нет.
   */
  private async validateInherits(
    code: string,
    raw: readonly string[],
    selfId?: string,
  ): Promise<string[]> {
    const inherits = Array.from(
      new Set(raw.map((c) => c.trim().toUpperCase()).filter((c) => c && c !== code)),
    );
    if (inherits.length === 0) return [];

    const catalog = await this.prisma.appRole.findMany({
      select: { code: true, inherits: true },
    });
    const known = new Set<string>([
      ...catalog.map((r) => r.code),
      // Системные коды считаем известными всегда: даже если строку в
      // справочнике снесли руками, декораторы `@Roles(...)` с этим кодом
      // никуда не делись и наследование от него осмысленно.
      ...SYSTEM_ROLE_CODES,
    ]);
    const unknown = inherits.filter((c) => !known.has(c));
    if (unknown.length > 0) throw new AppRoleUnknownParentException(unknown);

    // Каталог отдаём целиком: `findInheritanceCycle` сам подменяет в
    // графе рёбра правимой роли на новые (`byCode.set(code, inherits)`),
    // поэтому старую строку отфильтровывать не нужно.
    const cycle = findInheritanceCycle(code, inherits, catalog);
    if (cycle) throw new AppRoleInheritanceCycleException(cycle);

    return inherits;
  }

  private toDto(
    row: {
      id: string;
      code: string;
      name: string;
      system: boolean;
      inherits: string[];
      workspace: string;
      singleWorkspace: boolean;
      lockToWorkspace: boolean;
      active: boolean;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
    },
    employeeCount: number,
  ): AppRoleDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      system: row.system,
      inherits: row.inherits,
      workspace: row.workspace,
      singleWorkspace: row.singleWorkspace,
      lockToWorkspace: row.lockToWorkspace,
      active: row.active,
      sortOrder: row.sortOrder,
      employeeCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
