import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CompensationType, OrderDivision, Prisma, Role } from '@prisma/client';
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
 * конфигу (`name`, `division`, `isActive`). При любой ошибке —
 * `$transaction` откатывает обе записи, и в БД не остаётся «висящей»
 * половины. См. `docs/api.md §11`, `docs/screens.md §10e`.
 *
 * PHASE 1 «CompanyDivision как master-справочник» (см.
 * `prisma/schema.prisma::DisplayScreenConfig`,
 * `docs/domain.md §«Подразделения заказа»`): экран теперь привязан к
 * карточке `CompanyDivision` через `companyDivisionId`. Legacy
 * `enum OrderDivision` остаётся как backward-compat для существующих
 * URL-параметров `?division=…` и для исторических конфигов до
 * миграции; backend синхронизирует пару `(companyDivisionId,
 * legacy division)` по `code`.
 *
 * PIN хешируется тем же `bcrypt.hash(pin, 10)`, что и в
 * `EmployeesService.create` / `prisma/seed.ts` / `AuthService` —
 * чтобы существующий login-flow работал для DISPLAY-учёток без
 * каких-либо ответвлений.
 */
const PIN_HASH_COST = 10;

const KNOWN_LEGACY_CODES = new Set<OrderDivision>([
  OrderDivision.MARKETPLACE,
  OrderDivision.OTHER,
]);

function asLegacyDivision(value: unknown): OrderDivision | null {
  if (typeof value !== 'string') return null;
  if (value === 'MARKETPLACE') return OrderDivision.MARKETPLACE;
  if (value === 'OTHER') return OrderDivision.OTHER;
  return null;
}

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
   * PHASE 1: подгружаем краткие реквизиты `CompanyDivision`, чтобы
   * админ-таблица показывала имя без отдельного запроса.
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
        division: r.division,
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
   *   2. PHASE 1: резолвим пару `(companyDivisionId, division)` из
   *      DTO — либо новый FK, либо legacy enum, либо оба. Если
   *      пришёл только `companyDivisionId` — backend подкладывает
   *      legacy `division` по `code` (если код входит в whitelist
   *      `MARKETPLACE`/`OTHER`). Если пришёл только legacy
   *      `division` — backend ищет/upsert-ит карточку
   *      `CompanyDivision` по `code = division`. Если ни одного —
   *      400 `COMPANY_DIVISION_REQUIRED` (Zod-валидация уже это
   *      проверила, здесь — пояс поверх подтяжек).
   *   3. `$transaction([Employee.create, DisplayScreenConfig.create])`
   *      — атомарно. Если падает создание конфига (уникальность
   *      `employeeId`, неверный enum и т.п.) — Employee тоже
   *      откатывается. Без этого можно было бы получить «висящую»
   *      DISPLAY-учётку без экрана, которая бы потом мешала
   *      повторному созданию по тому же логину.
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

    // PHASE 1: резолвим пару (companyDivisionId, division) до открытия
    // транзакции. Карточку `CompanyDivision` можно искать вне
    // транзакции (read-only), а upsert по legacy-flow выполняется
    // внутри tx ниже, чтобы при ошибке создания Employee откатилось
    // и создание справочной карточки тоже (если её не было).
    const resolved = await this.resolveDivisionForCreate(dto);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // PHASE 1 (legacy upsert): если пришёл только legacy
        // `division` и карточки `CompanyDivision` с таким `code`
        // ещё нет (миграция/seed её должны были создать, но всякое
        // бывает) — мягко создаём её здесь, чтобы FK ниже не упал.
        let companyDivisionId = resolved.companyDivisionId;
        if (!companyDivisionId && resolved.legacyDivision) {
          const card = await tx.companyDivision.upsert({
            where: { code: resolved.legacyDivision },
            create: {
              code: resolved.legacyDivision,
              name:
                resolved.legacyDivision === OrderDivision.MARKETPLACE
                  ? 'Маркетплейс'
                  : 'B2B',
              sortOrder:
                resolved.legacyDivision === OrderDivision.MARKETPLACE ? 10 : 20,
              isActive: true,
            },
            update: {},
            select: { id: true },
          });
          companyDivisionId = card.id;
        }

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
            division: resolved.legacyDivision,
            // PHASE 1: пишем FK на справочник синхронно с legacy
            // enum. См. `docs/domain.md §«Подразделения заказа»».
            companyDivisionId,
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
          `employeeId=${result.employee.id} division=${result.config.division} ` +
          `companyDivisionId=${result.config.companyDivisionId ?? 'null'} ` +
          `login=${result.employee.login}`,
      );

      return toListDto({
        id: result.config.id,
        name: result.config.name,
        division: result.config.division,
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

  /**
   * PHASE 1: резолвит пару `(companyDivisionId, legacyDivision)` из
   * `CreateDisplayScreenDto`. Гарантирует, что итоговый
   * `legacyDivision !== null` — Prisma-колонка `division` по-прежнему
   * NOT NULL до PHASE 2.
   *
   * Контракт:
   *   - `companyDivisionId` есть → резолвим карточку, подкладываем
   *     legacy `division` по `code` (whitelist
   *     `MARKETPLACE`/`OTHER`). Если код карточки не в whitelist
   *     (например, менеджер завёл `MAIN_SHOP`), берём legacy
   *     `division` из dto, либо `OTHER` как безопасный fallback.
   *     Карточка not found → 400.
   *   - `companyDivisionId` нет, есть legacy `division` →
   *     возвращаем legacy `division` и `companyDivisionId = null`,
   *     транзакция выше upsert-нет карточку.
   *   - Оба пусты → 400 (это не должно случаться, Zod-валидация
   *     CreateDisplayScreenSchema это проверила).
   */
  private async resolveDivisionForCreate(
    dto: CreateDisplayScreenDto,
  ): Promise<{
    companyDivisionId: string | null;
    legacyDivision: OrderDivision;
  }> {
    if (dto.companyDivisionId) {
      const card = await this.prisma.companyDivision.findUnique({
        where: { id: dto.companyDivisionId },
        select: { id: true, code: true },
      });
      if (!card) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'COMPANY_DIVISION_NOT_FOUND',
          message: 'Подразделение не найдено',
        });
      }
      const legacyFromCard = asLegacyDivision(card.code);
      const legacyFromDto = asLegacyDivision(dto.division);
      const legacyDivision: OrderDivision =
        legacyFromCard ?? legacyFromDto ?? OrderDivision.OTHER;
      return {
        companyDivisionId: card.id,
        legacyDivision,
      };
    }

    const legacyFromDto = asLegacyDivision(dto.division);
    if (legacyFromDto && KNOWN_LEGACY_CODES.has(legacyFromDto)) {
      return { companyDivisionId: null, legacyDivision: legacyFromDto };
    }

    throw new BadRequestException({
      statusCode: 400,
      code: 'COMPANY_DIVISION_REQUIRED',
      message: 'Выберите подразделение',
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: string;
  name: string;
  division: OrderDivision;
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
    division: c.division,
    companyDivisionId: c.companyDivisionId,
    companyDivision: c.companyDivision,
    isActive: c.isActive,
    employeeId: c.employeeId,
    employeeLogin: c.employeeLogin,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
