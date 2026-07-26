import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CompensationType, Prisma, Role } from '@prisma/client';
import type {
  CreateDisplayScreenDto,
  DisplayScreenDetailDto,
  DisplayScreenListItemDto,
} from '@sewing/shared/display-screens';
import type { BulkArchiveResultDto } from '@sewing/shared/archive';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { indexById, runBulkArchive } from '../../common/bulk-archive.js';
import { DisplayLoginTakenException } from '../../common/errors.js';

/**
 * Сервис конфигурации display-экранов цеха (`DisplayScreenConfig`).
 *
 * Экран в наших терминах = пара `(DisplayScreenConfig, Employee role=DISPLAY)`.
 * Эта связка заводится строго через `create()` ниже одной транзакцией:
 * сначала создаём DISPLAY-учётку (логин/PIN), затем привязываем её к
 * конфигу (`name`, `companyDivisionId`, `isActive`). При любой ошибке —
 * `$transaction` откатывает обе записи, и в БД не остаётся «висящей»
 * половины. См. `docs/api.md §11`, `docs/screens.md §10e`.
 *
 * Подразделение экрана — FK на master-справочник `CompanyDivision`
 * (см. `prisma/schema.prisma::DisplayScreenConfig.companyDivisionId`,
 * `docs/domain.md §«Подразделения заказа»`).
 *
 * PIN хешируется тем же `bcrypt.hash(pin, 10)`, что и в
 * `EmployeesService.create` / `prisma/seed.ts` / `AuthService` —
 * чтобы существующий login-flow работал для DISPLAY-учёток без
 * каких-либо ответвлений.
 */
const PIN_HASH_COST = 10;

@Injectable()
export class DisplayScreensService {
  private readonly logger = new Logger(DisplayScreensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  /**
   * Полный листинг для админ-страницы `/admin/display-screens`. Сейчас
   * экранов мало (десятки максимум) — пагинацию и фильтры вводить
   * преждевременно. Сортировка по дате создания: свежий экран сверху,
   * чтобы только что заведённый сразу был на виду.
   *
   * Подгружаем краткие реквизиты `CompanyDivision`, чтобы админ-таблица
   * показывала имя подразделения без отдельного запроса.
   */
  async list(): Promise<DisplayScreenListItemDto[]> {
    const rows = await this.prisma.displayScreenConfig.findMany({
      orderBy: [{ createdAt: 'desc' }],
      include: {
        employee: { select: { id: true, login: true } },
        companyDivision: {
          select: { id: true, code: true, name: true },
        },
      },
    });
    return rows.map((r) =>
      toListDto({
        id: r.id,
        name: r.name,
        companyDivisionId: r.companyDivisionId,
        companyDivision: r.companyDivision
          ? {
              id: r.companyDivision.id,
              code: r.companyDivision.code,
              name: r.companyDivision.name,
            }
          : null,
        isActive: r.isActive,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        employeeId: r.employee.id,
        employeeLogin: r.employee.login,
      }),
    );
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  /**
   * Создаёт display-экран и привязанную к нему DISPLAY-учётку в одной
   * транзакции. Это единственный поддерживаемый flow создания DISPLAY-
   * аккаунтов из админки: `/admin/employees/new` сознательно не
   * включает `DISPLAY` в `EMPLOYEE_ROLES`.
   *
   * Шаги:
   *   1. `bcrypt.hash(pin, 10)` — снаружи транзакции, потому что
   *      хеширование тяжёлое (~50–200 мс) и не должно держать
   *      открытую транзакцию.
   *   2. Валидируем существование `CompanyDivision` по
   *      `companyDivisionId`. Если карточки нет — 400
   *      `COMPANY_DIVISION_NOT_FOUND`, чтобы UI получил адресную
   *      ошибку вместо сырого FK-сбоя.
   *   3. `$transaction([Employee.create, DisplayScreenConfig.create])`
   *      — атомарно. Если падает создание конфига (уникальность
   *      `employeeId` и т.п.) — Employee тоже откатывается. Без этого
   *      можно было бы получить «висящую» DISPLAY-учётку без экрана,
   *      которая бы потом мешала повторному созданию по тому же логину.
   *   4. `P2002` на `Employee.login` транслируется в стабильный
   *      `DISPLAY_LOGIN_TAKEN` (`409`), чтобы UI подсветил поле
   *      «Логин дисплея» (см. `docs/api.md §11`).
   *
   * `compensationType = SALARY` для DISPLAY-учётки выбран как
   * «нейтральный»: SALARY-сотрудник в payroll даёт 0 при отсутствии
   * `salaryPerShift` и не попадает в сдельные начисления, а PIECEWORK
   * без расценок логировался бы как невычисляемый. Учётка дисплея
   * не должна влиять на ФОТ.
   */
  async create(dto: CreateDisplayScreenDto): Promise<DisplayScreenDetailDto> {
    const pinHash = await bcrypt.hash(dto.pin, PIN_HASH_COST);

    // Валидация существования карточки до открытия транзакции —
    // read-only запрос, дешёвый и независимый от Employee-create.
    const card = await this.prisma.companyDivision.findUnique({
      where: { id: dto.companyDivisionId },
      select: { id: true },
    });
    if (!card) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'COMPANY_DIVISION_NOT_FOUND',
        message: 'Подразделение не найдено',
      });
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const employee = await tx.employee.create({
          data: {
            // Видимое имя в auth/me и в журнале событий: «Display: <имя
            // экрана>». Это чисто для отладки и UI; внутри сервисов мы
            // эту учётку идентифицируем по `role = DISPLAY`.
            fullName: `Display: ${dto.name}`,
            login: dto.login,
            pinHash,
            role: Role.DISPLAY,
            // Дисплей — не реальный сотрудник; «оклад» проставлять
            // нечем и не нужно. SALARY без `salaryPerHour` по
            // payroll-инвариантам даёт ноль в `SalaryService` и не
            // мешает existing flow. См. ADR-0021 §«SALARY».
            compensationType: CompensationType.SALARY,
            salaryPerHour: null,
            active: true,
          },
        });

        const config = await tx.displayScreenConfig.create({
          data: {
            name: dto.name,
            companyDivisionId: card.id,
            employeeId: employee.id,
            isActive: dto.isActive,
          },
          include: {
            companyDivision: {
              select: { id: true, code: true, name: true },
            },
          },
        });

        return { employee, config };
      });

      this.logger.log(
        `event=display-screen.create id=${result.config.id} ` +
          `employeeId=${result.employee.id} ` +
          `companyDivisionId=${result.config.companyDivisionId ?? 'null'} ` +
          `login=${result.employee.login}`,
      );

      return toListDto({
        id: result.config.id,
        name: result.config.name,
        companyDivisionId: result.config.companyDivisionId,
        companyDivision: result.config.companyDivision
          ? {
              id: result.config.companyDivision.id,
              code: result.config.companyDivision.code,
              name: result.config.companyDivision.name,
            }
          : null,
        isActive: result.config.isActive,
        createdAt: result.config.createdAt,
        updatedAt: result.config.updatedAt,
        employeeId: result.employee.id,
        employeeLogin: result.employee.login,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = (e.meta?.target as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        if (fields.some((f) => String(f).includes('login'))) {
          throw new DisplayLoginTakenException();
        }
      }
      throw e;
    }
  }

  // ===========================================================================
  // АРХИВ ЭКРАНОВ — bulk archive / restore / purge
  // ===========================================================================
  //
  // Общий контур справочников админки (`@sewing/shared/archive`).
  // Архив экрана — `isActive = false`. Важная особенность раздела:
  // экран = пара `(DisplayScreenConfig, Employee role=DISPLAY)`, поэтому
  // архивация ГАСИТ и учётку монитора (`employee.active = false`) —
  // иначе «отключённый» экран продолжал бы логиниться. Восстановление
  // зажигает обратно.
  //
  // purge удаляет конфиг и пытается удалить саму DISPLAY-учётку
  // (её login занимает уникальный индекс — иначе новый экран с тем же
  // логином не заведёшь). Если на учётку успели повеситься ссылки
  // (событие паспорта, смена), delete упадёт по FK — тогда оставляем
  // её деактивированной: чистка справочника не должна ломать историю.

  async archiveMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.displayScreenConfig.findMany({
            where: { id: { in: want } },
            select: { id: true, isActive: true, employeeId: true },
          }),
        ),
      alreadyDone: (row) => !row.isActive,
      gate: () => null,
      apply: async (rows, targetIds) => {
        const employeeIds = rows.map((r) => r.employeeId);
        await this.prisma.$transaction(async (tx) => {
          await tx.displayScreenConfig.updateMany({
            where: { id: { in: targetIds } },
            data: { isActive: false },
          });
          await tx.employee.updateMany({
            where: { id: { in: employeeIds } },
            data: { active: false },
          });
          await this.audit.log(
            {
              event: 'DISPLAY_SCREENS_ARCHIVED',
              entityType: 'DISPLAY_SCREEN',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { screenIds: targetIds, employeeIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=display_screen.archive processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async restoreMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.displayScreenConfig.findMany({
            where: { id: { in: want } },
            select: { id: true, isActive: true, employeeId: true },
          }),
        ),
      alreadyDone: (row) => row.isActive,
      gate: () => null,
      apply: async (rows, targetIds) => {
        const employeeIds = rows.map((r) => r.employeeId);
        await this.prisma.$transaction(async (tx) => {
          await tx.displayScreenConfig.updateMany({
            where: { id: { in: targetIds } },
            data: { isActive: true },
          });
          await tx.employee.updateMany({
            where: { id: { in: employeeIds } },
            data: { active: true },
          });
          await this.audit.log(
            {
              event: 'DISPLAY_SCREENS_RESTORED',
              entityType: 'DISPLAY_SCREEN',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { screenIds: targetIds, employeeIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=display_screen.restore processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async purgeMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.displayScreenConfig.findMany({
            where: { id: { in: want } },
            select: {
              id: true,
              name: true,
              isActive: true,
              employeeId: true,
              employee: { select: { login: true } },
            },
          }),
        ),
      gate: (row) =>
        row.isActive ? { reason: 'NOT_ARCHIVED' as const } : null,
      apply: async (rows) => {
        for (const row of rows) {
          await this.prisma.$transaction(async (tx) => {
            await tx.displayScreenConfig.delete({ where: { id: row.id } });
            await this.audit.log(
              {
                event: 'DISPLAY_SCREEN_DELETED',
                entityType: 'DISPLAY_SCREEN',
                entityId: row.id,
                employeeId: actorEmployeeId ?? null,
                payload: {
                  name: row.name,
                  employeeId: row.employeeId,
                  employeeLogin: row.employee.login,
                  bulk: true,
                },
              },
              tx,
            );
          });
          // Учётку монитора чистим ОТДЕЛЬНОЙ операцией, а не внутри той
          // же транзакции: если у неё внезапно есть история, delete
          // упадёт по FK и откатил бы удаление конфига вместе с собой.
          try {
            await this.prisma.employee.delete({ where: { id: row.employeeId } });
          } catch {
            await this.prisma.employee.update({
              where: { id: row.employeeId },
              data: { active: false },
            });
            this.logger.warn(
              `event=display_screen.purge.employee_kept id=${row.employeeId} login=${row.employee.login} reason=has_refs`,
            );
          }
        }
      },
    });
    this.logger.log(
      `event=display_screen.purge processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: string;
  name: string;
  companyDivisionId: string | null;
  companyDivision: { id: string; code: string; name: string } | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  employeeId: string;
  employeeLogin: string;
}

function toListDto(c: ConfigRow): DisplayScreenListItemDto {
  return {
    id: c.id,
    name: c.name,
    companyDivisionId: c.companyDivisionId,
    companyDivision: c.companyDivision,
    isActive: c.isActive,
    employeeId: c.employeeId,
    employeeLogin: c.employeeLogin,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
