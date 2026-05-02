import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CompensationType, Prisma, Role } from '@prisma/client';
import type {
  CreateDisplayScreenDto,
  DisplayScreenDetailDto,
  DisplayScreenListItemDto,
} from '@sewing/shared/display-screens';
import { PrismaService } from '../../prisma/prisma.service.js';
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

  constructor(private readonly prisma: PrismaService) {}

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
            // нечем и не нужно. SALARY без `salaryPerShift` по
            // payroll-инвариантам даёт ноль в `SalaryService` и не
            // мешает existing flow. См. ADR-0021 §«SALARY».
            compensationType: CompensationType.SALARY,
            salaryPerShift: null,
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
