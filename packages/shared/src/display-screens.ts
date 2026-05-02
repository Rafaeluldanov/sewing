/**
 * Контракты модуля «Display screens» — большие мониторы цеха
 * (`/shopfloor/display`).
 *
 * Контекст: у каждого экрана есть отдельная запись
 * `DisplayScreenConfig` с привязанной DISPLAY-учёткой (`Employee` с
 * `role = DISPLAY`) и FK на `CompanyDivision`. Подразделение
 * определяется автоматически по логину DISPLAY-пользователя.
 * Query-параметр `?divisionCode=<CompanyDivision.code>` продолжает
 * работать и перекрывает конфиг — это удобно для отладки и для
 * экранов без отдельной DISPLAY-учётки.
 *
 * Источники истины:
 *   - доменная модель: `prisma/schema.prisma → DisplayScreenConfig`,
 *     раздел «Display screens»;
 *   - API: `docs/api.md §11` (POST /api/display-screens);
 *   - UI: `docs/screens.md §10e` (`/admin/display-screens`).
 */

import { z } from 'zod';

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
 *   2) `DisplayScreenConfig` (name + companyDivisionId + isActive,
 *      employeeId — id только что созданного сотрудника).
 *
 * Если падает любой шаг — оба rollback'аются. Поэтому DTO обязан
 * содержать сразу обе порции данных: «о ком учётка» (login/pin) и
 * «что показывает экран» (name/companyDivisionId/isActive).
 *
 * `companyDivisionId` обязателен: UI выбирает подразделение из
 * `CompanyDivision`-селекта, backend пишет FK напрямую в
 * `DisplayScreenConfig.companyDivisionId`. На несуществующую
 * карточку backend отвечает 400 `COMPANY_DIVISION_NOT_FOUND`.
 */
export const CreateDisplayScreenSchema = z.object({
  name: ScreenNameField,
  companyDivisionId: z
    .string()
    .min(1, 'Выберите подразделение'),
  login: DisplayLoginField,
  pin: DisplayPinField,
  /** Дефолт `true` — обычно создают сразу включённый экран. */
  isActive: z.boolean().optional().default(true),
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
   * FK на `CompanyDivision`. `null` — подразделение не указано
   * (экран показывает «общий» агрегат до привязки в админке).
   */
  companyDivisionId: string | null;
  /**
   * Краткие реквизиты привязанной карточки `CompanyDivision`,
   * чтобы админ-таблица показывала имя без отдельного запроса.
   */
  companyDivision: { id: string; code: string; name: string } | null;
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
