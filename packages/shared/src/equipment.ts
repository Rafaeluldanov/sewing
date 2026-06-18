/**
 * Контракты управления оборудованием и его разрешёнными операциями
 * (см. ADR-0017 «Equipment ↔ Operation: backend source of truth»).
 *
 * Источник истины — backend: таблица `EquipmentOperation` (M2M между
 * `Equipment` и `Operation`). Раньше эта связь жила во фронтовом
 * mapping по префиксу `Equipment.code` (см. историю
 * `apps/web/lib/equipment-operations.ts`); MVP «equipment-config»
 * убирает хардкод и переводит /work на чтение allow-листа из API.
 */

import { z } from 'zod';

import { EMPLOYEE_ROLES } from './employees';

/**
 * Роль «рабочего места» (`Equipment.role`, фича «смена роли сканом»,
 * 18.06.2026). Сканируя QR этого оборудования в кабинете, сотрудник
 * переключается на терминал указанной роли (если она входит в его
 * `Employee.roles`). Допустимые значения — те же assignable-роли, что
 * и у сотрудника (`EMPLOYEE_ROLES`, без `DISPLAY`). `null`/пустая
 * строка — рабочее место не привязано к роли (в скан-переключении не
 * участвует), `undefined` — поле не трогаем (для PATCH).
 *
 * Реализовано через `z.string().refine(...)`, а не `z.enum`, чтобы
 * вход и выход поля были одного типа (`string | null | undefined`):
 * иначе расхождение input/output ломает вывод дженерика
 * `ZodValidationPipe` на контроллере (см. equipment.controller.ts).
 */
const RoleStringField = z
  .string()
  .refine(
    (v) => (EMPLOYEE_ROLES as readonly string[]).includes(v),
    'Недопустимая роль рабочего места',
  );
const WorkplaceRoleField = z
  .union([RoleStringField, z.literal(''), z.null()])
  .optional()
  .transform((v): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    return v;
  });

/**
 * Запись разрешённой операции для конкретной единицы оборудования.
 *
 * Поле `sortOrder` управляет порядком отображения на /work (швея
 * выбирает операцию из карточки оборудования). `isActive` нужно
 * для мягкого отключения операции без удаления связи —
 * на /work неактивные не показываются.
 */
export interface EquipmentOperationLinkDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  operationCategory: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Карточка оборудования с включёнными операциями (для /admin/equipment
 * и для расширенного `GET /api/shifts/meta`).
 */
export interface EquipmentDetailDto {
  id: string;
  code: string;
  qrCode: string;
  name: string;
  /**
   * Ручной отображаемый порядковый номер станка («№1», «№2»…).
   * Заполняется в `/admin/equipment` и крупно печатается на QR-этикетке
   * оборудования (`GET /api/equipment/:id/print`). `null` означает «не
   * задан» — admin UI подсветит это, чтобы предложить заполнить.
   */
  displayNumber: string | null;
  active: boolean;
  /**
   * Роль «рабочего места» для скан-переключения (`Equipment.role`,
   * фича «смена роли сканом»). `null` — не привязано к роли.
   */
  role: string | null;
  /** Только активные операции, отсортированы по `sortOrder` (asc). */
  allowedOperations: EquipmentOperationLinkDto[];
}

/** Облегчённая сводка для списка `/admin/equipment` и аналогичных вьюх. */
export interface EquipmentSummaryDto {
  id: string;
  code: string;
  qrCode: string;
  name: string;
  /** См. `EquipmentDetailDto.displayNumber`. */
  displayNumber: string | null;
  active: boolean;
  /** Роль «рабочего места» (`Equipment.role`). `null` — не привязано. */
  role: string | null;
  /** Сколько активных операций сейчас разрешено для этого оборудования. */
  allowedOperationsCount: number;
  /**
   * Уникальные категории связанных операций в каноническом порядке
   * (`OPERATION_CATEGORY_ORDER`). Нужны UI для группировки списка
   * `/admin/equipment` по primary-категории и отрисовки category
   * chips (см. ТЗ «Единая группировка», §6).
   *
   * Поле сознательно «лёгкое» (массив строк, не массив операций):
   * полный список разрешённых операций живёт в `EquipmentDetailDto`,
   * на списочной странице нам достаточно категорий.
   *
   * Бекенд читает только из существующих `Operation.category` —
   * Prisma не меняется.
   */
  operationCategories: string[];
}

/**
 * Общие правила валидации полей оборудования. Вынесены в одно место,
 * чтобы `CreateEquipmentSchema`, `UpdateEquipmentSchema` и
 * `UpdateEquipmentOperationsSchema` гарантировали один и тот же
 * контракт (длина, обязательность, нормализация).
 */
const NameField = z
  .string()
  .trim()
  .min(1, 'Название оборудования обязательно')
  .max(120, 'Название оборудования слишком длинное (макс. 120 символов)');

const DisplayNumberField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine(
    (v) => v === undefined || v === null || v.length <= 16,
    'displayNumber должен быть не длиннее 16 символов',
  );

const OperationIdsField = z
  .array(z.string().min(1, 'operationId не может быть пустым'))
  .max(100, 'Слишком много операций')
  .refine(
    (ids) => new Set(ids).size === ids.length,
    'Operation IDs не должны повторяться',
  );

/**
 * Тело `PATCH /api/equipment/:id/operations` — полная замена набора
 * разрешённых операций. Передаётся плоский список `Operation.id`,
 * порядок задаёт sortOrder. Дубликаты запрещены.
 */
export const UpdateEquipmentOperationsSchema = z.object({
  operationIds: OperationIdsField,
});
export type UpdateEquipmentOperationsDto = z.infer<
  typeof UpdateEquipmentOperationsSchema
>;

/**
 * Тело `POST /api/equipment` — создание новой единицы оборудования
 * из `/admin/equipment` (роли `ADMIN`, `SHOP_MANAGER`).
 *
 * Контракт намеренно небольшой:
 *   - `name` — обязательное человекочитаемое название;
 *   - `code` — опциональный короткий технический идентификатор (уникален).
 *     Если не задан, backend сам сгенерирует код из slug имени с
 *     суффиксом для уникальности — менеджеру не нужно придумывать
 *     `overlock-03` руками. UI поле всё-таки показывает (для тех,
 *     кто хочет управлять кодом сам);
 *   - `displayNumber` — опциональный ручной номер станка
 *     (см. `docs/domain.md §5c`);
 *   - `operationIds` — опциональный набор разрешённых операций.
 *     Если передан, после создания оборудования в той же транзакции
 *     создаются связи `EquipmentOperation` (sortOrder = индекс * 10).
 *
 * `qrCode` сознательно НЕ принимается — backend ставит каноничный
 * `equipment:{id}` (ADR-0008), чтобы scan flow остался совместимым.
 * `active` — всегда `true` при создании; деактивация — отдельным
 * PATCH-ом (вне MVP).
 */
export const CreateEquipmentSchema = z.object({
  name: NameField,
  code: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return undefined;
      const trimmed = v.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .refine(
      (v) => v === undefined || /^[a-z0-9][a-z0-9-]{0,63}$/.test(v),
      'Код оборудования — только латинские строчные буквы, цифры и дефис, до 64 символов',
    ),
  displayNumber: DisplayNumberField,
  /**
   * Роль «рабочего места» (`Equipment.role`). Опционально: `null` /
   * пустая строка / `undefined` — без привязки к роли. Для участков
   * ОТК/ВТО/Упаковка/Крой менеджер выбирает соответствующую роль,
   * чтобы рабочее место участвовало в скан-переключении.
   */
  role: WorkplaceRoleField,
  operationIds: OperationIdsField.optional(),
});
export type CreateEquipmentDto = z.infer<typeof CreateEquipmentSchema>;

/** Re-export для UI-кода (валидация slug на стороне формы). */
export const EQUIPMENT_CODE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const EQUIPMENT_NAME_MAX_LENGTH = 120;
export const EQUIPMENT_CODE_MAX_LENGTH = 64;
export const EQUIPMENT_DISPLAY_NUMBER_MAX_LENGTH = 16;

/**
 * Тело `PATCH /api/equipment/:id` — точечное обновление карточки.
 *
 * Поля:
 *   - `name` — переименование оборудования (обязательное при наличии);
 *   - `displayNumber` — ручной отображаемый номер станка (или `null`
 *     для сброса). Пустая строка после трима трактуется как `null`.
 *
 * Хотя бы одно поле должно прийти, иначе `400 VALIDATION_ERROR`
 * (см. `.refine` ниже) — это защита от «пустого PATCH».
 *
 * Контракт сознательно узкий: `code`, `qrCode`, `active` пока не
 * меняются через эту ручку, чтобы не плодить большой CRUD ради
 * редких управленческих действий (см. ADR-0017 §5).
 */
export const UpdateEquipmentSchema = z
  .object({
    name: NameField.optional(),
    displayNumber: DisplayNumberField,
    /**
     * Роль «рабочего места» (`Equipment.role`). `undefined` — не
     * трогаем; `null` / пустая строка — снять привязку к роли; роль —
     * привязать (рабочее место станет точкой скан-переключения).
     */
    role: WorkplaceRoleField,
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.displayNumber !== undefined ||
      obj.role !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateEquipmentDto = z.infer<typeof UpdateEquipmentSchema>;
