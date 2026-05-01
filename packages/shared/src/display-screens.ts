/**
 * Контракты модуля «Display screens» — большие мониторы цеха
 * (`/shopfloor/display`).
 *
 * Контекст: раньше дисплей фильтровался по подразделению вручную через
 * `?division=MARKETPLACE` в URL. Теперь у каждого экрана есть отдельная
 * запись `DisplayScreenConfig` с привязанной DISPLAY-учёткой
 * (`Employee` с `role = DISPLAY`), и `division` определяется
 * автоматически по логину. Query-параметр продолжает работать и
 * перекрывает конфиг — это backward-compatibility со старыми
 * закладками.
 *
 * Источники истины:
 *   - доменная модель: `prisma/schema.prisma → DisplayScreenConfig`,
 *     раздел «Display screens»;
 *   - API: `docs/api.md §11` (POST /api/display-screens);
 *   - UI: `docs/screens.md §10e` (`/admin/display-screens`).
 */

import { z } from 'zod';

import { OrderDivisionSchema, type OrderDivision } from './orders';

// ---------------------------------------------------------------------------
// Helpers (зеркало правил `Employee.login` / `Employee.pinHash`)
// ---------------------------------------------------------------------------

/**
 * Имя экрана для админ-листинга. Не отдаётся фронту дисплея — это
 * сугубо менеджерское поле «как мы называем эту железку у себя».
 * Длина намеренно щадящая: «ТВ маркетплейс на стене у выхода» вписать
 * можно, простыни — нет.
 */
const ScreenNameField = z
  .string()
  .trim()
  .min(2, 'Название экрана должно быть не короче 2 символов')
  .max(120, 'Название экрана слишком длинное (макс. 120 символов)');

/**
 * Логин для DISPLAY-учётки. Правила те же, что у обычного `Employee`
 * (см. `employees.ts → LoginField`): trim + lower-case + min 2 / max 64.
 * Уникальность гарантируется `Employee.login @unique`; при коллизии
 * сервис возвращает `409 DISPLAY_LOGIN_TAKEN`.
 */
const DisplayLoginField = z
  .string()
  .trim()
  .min(2, 'Логин должен быть не короче 2 символов')
  .max(64, 'Логин слишком длинный (макс. 64 символа)')
  .transform((v) => v.toLowerCase());

/**
 * PIN для DISPLAY-учётки. На MVP большой монитор тыкают физически,
 * пин-код короткий — 4 символа минимум, как у остальных сотрудников.
 * В БД хранится только `bcrypt.hash(pin, 10)`; сам PIN наружу не
 * отдаётся ни в одном DTO.
 */
const DisplayPinField = z
  .string()
  .min(4, 'PIN должен быть не короче 4 символов')
  .max(100, 'PIN слишком длинный (макс. 100 символов)');

// ---------------------------------------------------------------------------
// Create DTO (POST /api/display-screens)
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/display-screens` (см. `docs/api.md §11`).
 *
 * Один запрос → одна транзакция → две сущности:
 *   1) `Employee` (role = DISPLAY, login/pin из этого DTO);
 *   2) `DisplayScreenConfig` (name + division + isActive,
 *      employeeId — id только что созданного сотрудника).
 *
 * Если падает любой шаг — оба rollback'аются. Поэтому DTO обязан
 * содержать сразу обе порции данных: «о ком учётка» (login/pin) и
 * «что показывает экран» (name/division/isActive).
 *
 * PHASE 1 «CompanyDivision как master-справочник» (см.
 * `prisma/schema.prisma::DisplayScreenConfig`,
 * `DisplayScreensService.create`): UI выбирает подразделение из
 * `CompanyDivision` и шлёт `companyDivisionId`. Backend
 * синхронизирует legacy `division` enum по `CompanyDivision.code`,
 * если код — `MARKETPLACE`/`OTHER`. Если фронт прислал только
 * legacy `division` (старые интеграции / smoke-тесты), backend
 * найдёт/upsert-ит карточку `CompanyDivision` по `code`.
 */
export const CreateDisplayScreenSchema = z.object({
  name: ScreenNameField,
  /**
   * Legacy enum-подразделение (`MARKETPLACE`/`OTHER`). На PHASE 1
   * опционально — если задан только `companyDivisionId`, backend
   * сам подкладывает enum по `code`. Старые формы продолжают
   * передавать это поле и работают как раньше.
   */
  division: OrderDivisionSchema.optional(),
  /**
   * PHASE 1: новый источник истины подразделения экрана. Если
   * задан — backend пишет `DisplayScreenConfig.companyDivisionId`
   * и подкладывает legacy `division` по `code`.
   *
   * Либо `companyDivisionId`, либо `division` обязан быть задан —
   * `superRefine` ниже это проверит, чтобы UI получил адресную
   * ошибку «выберите подразделение», а не FK-сбой на backend.
   */
  companyDivisionId: z.string().min(1).optional(),
  login: DisplayLoginField,
  pin: DisplayPinField,
  /** Дефолт `true` — обычно создают сразу включённый экран. */
  isActive: z.boolean().optional().default(true),
}).superRefine((dto, ctx) => {
  if (!dto.companyDivisionId && !dto.division) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['companyDivisionId'],
      message: 'Выберите подразделение',
    });
  }
});
export type CreateDisplayScreenDto = z.infer<typeof CreateDisplayScreenSchema>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Элемент списка `/admin/display-screens`. Достаточно для таблицы:
 * имя, подразделение, логин привязанной DISPLAY-учётки, флаг.
 *
 * `pin` не возвращается принципиально (в БД его нет — только bcrypt-
 * hash, см. `Employee.pinHash`). Если оператор забыл PIN — он удаляет
 * экран и заводит заново.
 */
export interface DisplayScreenListItemDto {
  id: string;
  name: string;
  /**
   * PHASE 1: legacy enum-подразделение, оставлено как
   * backward-compat. UI должен предпочитать `companyDivision?.name`,
   * а fallback на `division` использовать только если
   * `companyDivision = null`. PHASE 2 уберёт это поле из DTO.
   */
  division: OrderDivision;
  /**
   * PHASE 1 «CompanyDivision как master-справочник» (см.
   * `DisplayScreensService.list`): id привязанной карточки
   * подразделения. `null` для исторических конфигов до миграции —
   * UI fallback-ит на `division` с `ORDER_DIVISION_LABELS`.
   *
   * Поле опционально (`?`) — старые потребители без пересборки
   * shared-пакета продолжают компилироваться.
   */
  companyDivisionId?: string | null;
  /**
   * PHASE 1: краткие реквизиты привязанной карточки `CompanyDivision`,
   * чтобы админ-таблица показывала имя без отдельного запроса.
   */
  companyDivision?: { id: string; code: string; name: string } | null;
  isActive: boolean;
  /** Логин привязанной DISPLAY-учётки. */
  employeeLogin: string;
  /** ID привязанной DISPLAY-учётки. Полезно для деталей/линков. */
  employeeId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Ответ `POST /api/display-screens`. Совпадает по форме со списочным
 * элементом — отдельный «детальный» DTO на MVP не нужен (карточки
 * просмотра/редактирования экрана пока нет).
 */
export type DisplayScreenDetailDto = DisplayScreenListItemDto;
