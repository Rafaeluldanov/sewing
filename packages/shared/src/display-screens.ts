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
 *
 * Хранится так же, как PIN обычного сотрудника — парой колонок
 * `Employee.pinHash` (bcrypt, по нему вход) и `Employee.pinEnc`
 * (обратимая AES-копия), см. `apps/api/src/common/pin-columns.ts`.
 * Ни одно DTO ЭТОГО модуля PIN не отдаёт, но посмотреть его можно:
 * DISPLAY-учётка — обычная строка `Employee`, и в её карточке
 * `/admin/employees/[id]` работает кнопка «Показать»
 * (аудируемый `POST /api/employees/:id/reveal-pin`). Гейта на это нет
 * сознательно: монитор настраивает мастер, привилегированной эта
 * учётка не является.
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
 * `pin` не возвращается принципиально: ни в этом DTO, ни в карточке
 * экрана PIN не показывается. Забытый PIN монитора теперь не требует
 * пересоздания экрана — его либо задают заново формой «PIN монитора»,
 * либо СМОТРЯТ в карточке DISPLAY-учётки `/admin/employees/[id]`
 * (аудируемый `POST /api/employees/:id/reveal-pin`; учётка монитора —
 * такой же `Employee`).
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
 * Ответ `POST /api/display-screens`, `GET /api/display-screens/:id` и
 * `PATCH /api/display-screens/:id`. Совпадает по форме со списочным
 * элементом: карточка экрана показывает ровно те же поля, отдельных
 * «деталей» у конфига нет.
 */
export type DisplayScreenDetailDto = DisplayScreenListItemDto;

// ---------------------------------------------------------------------------
// Update DTO (PATCH /api/display-screens/:id)
// ---------------------------------------------------------------------------

/**
 * Тело `PATCH /api/display-screens/:id` (см. `docs/api.md §33`).
 *
 * Зачем: экран живёт в цехе годами, а его атрибуты меняются —
 * подразделение переехало на другой монитор, железку переименовали,
 * PIN забыли. До этой ручки единственным выходом было «удалить экран и
 * завести заново», что рвало DISPLAY-учётку (и её логин, занятый
 * уникальным индексом).
 *
 * Все поля необязательны — присылаем только то, что реально меняем;
 * пустой объект допустим и является no-op (backend вернёт текущее
 * состояние). Правила полей ровно те же, что при создании, поэтому
 * переиспользуем те же поля-схемы: расхождение «создать можно, а
 * сохранить нельзя» было бы худшим из багов этой формы.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
 *   - `isActive` — включением/выключением экрана заведует контур
 *     архива (`POST /archive|restore`), и он же гасит и зажигает
 *     DISPLAY-учётку. Второй путь к тому же флагу неизбежно
 *     разъехался бы с `Employee.active`;
 *   - удаление — только `POST /purge` из архива (там же чистится
 *     учётка, иначе её логин остаётся занятым навсегда).
 *
 * `pin` — смена PIN'а монитора. Присылается ТОЛЬКО когда его реально
 * меняют: пустая строка/отсутствие поля = «оставить как есть». Наружу
 * PIN по-прежнему не отдаётся ни в одном DTO (в БД лежит лишь
 * bcrypt-hash).
 */
export const UpdateDisplayScreenSchema = z
  .object({
    name: ScreenNameField.optional(),
    companyDivisionId: z
      .string()
      .min(1, 'Выберите подразделение')
      .optional(),
    login: DisplayLoginField.optional(),
    pin: DisplayPinField.optional(),
  })
  .strict();
export type UpdateDisplayScreenDto = z.infer<typeof UpdateDisplayScreenSchema>;
