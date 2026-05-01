/**
 * Контракты модуля «Склады» (управленческая группировка ячеек).
 *
 * Источник истины — backend (`/api/warehouses` + `PATCH /api/cells/:id`).
 * Введён вместе с экраном `/admin/warehouses` (см. `docs/domain.md §16`,
 * `docs/erd.md §2.13a`, `docs/api.md §15`, `docs/screens.md §10b`).
 *
 * Скоуп MVP сознательно ограничен:
 *   - Warehouse = name + (optional) code + isActive;
 *   - связь с Cell — `Cell.warehouseId nullable` (см. ADR-0019);
 *   - привязка ячейки к складу — `PATCH /api/cells/:id`;
 *   - QR-печать ячейки — `GET /api/cells/:id/print` (тот же payload
 *     `cell:{id}` по ADR-0008, формат не меняется).
 *
 * За рамками MVP: зоны/секции/полки, capacity-планирование, история
 * перемещений ячеек между складами.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/warehouses`.
 *
 * `name` — обязательное человекочитаемое имя склада. `code` —
 * опциональный короткий идентификатор (напр., `MAIN`, `WH-01`).
 * Пустая строка после трима трактуется как «не задан» (`null`),
 * чтобы UI-форма не заставляла менеджера придумывать код.
 */
/**
 * Шаблон печатной формы наклейки. На MVP — просто строка (или JSON,
 * сериализованный в строку), без жёсткой схемы. Менеджер может положить
 * произвольный человекочитаемый текст: бизнес-логика рендера наклеек
 * появится позже. Пустая строка после трима = `null`.
 */
const LabelTemplateField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine(
    (v) => v === undefined || v === null || v.length <= 4000,
    'Шаблон наклейки слишком длинный (макс. 4000 символов)',
  );

export const CreateWarehouseSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Название склада обязательно')
    .max(120, 'Название слишком длинное'),
  code: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .refine(
      (v) => v === null || v.length <= 32,
      'Код склада должен быть не длиннее 32 символов',
    ),
  isActive: z.boolean().optional(),
  labelTemplate: LabelTemplateField,
});
export type CreateWarehouseDto = z.infer<typeof CreateWarehouseSchema>;

/**
 * Тело `PATCH /api/warehouses/:id` — точечное редактирование. Любое
 * поле опционально, но хотя бы одно должно прийти, иначе нет смысла
 * вызывать ручку (см. `.refine` ниже).
 */
export const UpdateWarehouseSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Название склада обязательно')
      .max(120, 'Название слишком длинное')
      .optional(),
    code: z
      .union([z.string(), z.null()])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
      })
      .refine(
        (v) => v === undefined || v === null || v.length <= 32,
        'Код склада должен быть не длиннее 32 символов',
      ),
    isActive: z.boolean().optional(),
    labelTemplate: LabelTemplateField,
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.code !== undefined ||
      obj.isActive !== undefined ||
      obj.labelTemplate !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateWarehouseDto = z.infer<typeof UpdateWarehouseSchema>;

// ---------------------------------------------------------------------------
// Warehouse lines (массовое создание ячеек через линию)
// ---------------------------------------------------------------------------

/**
 * Лимит количества ячеек, создаваемых одной линией. Цель — отсечь
 * случайный ввод вроде «20000» (опечатка), а не поддержать произвольно
 * большие склады. На MVP 200 хватает с запасом для типовой полки.
 */
export const WAREHOUSE_LINE_MAX_COUNT = 200;

/**
 * Тело `POST /api/warehouses/:id/lines`.
 *
 * `code` — глобально уникальный код линии (уникальность валидируется
 * на backend, здесь — только формат). `count` — сколько ячеек создать
 * с кодами `${code}1`, `${code}2`, ..., `${code}${count}`.
 */
export const CreateWarehouseLineSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'Код линии обязателен')
    .max(32, 'Код линии слишком длинный (макс. 32 символа)'),
  count: z
    .number()
    .int('Количество должно быть целым числом')
    .min(1, 'Минимум 1 ячейка')
    .max(
      WAREHOUSE_LINE_MAX_COUNT,
      `Слишком много ячеек за один раз (макс. ${WAREHOUSE_LINE_MAX_COUNT})`,
    ),
});
export type CreateWarehouseLineDto = z.infer<typeof CreateWarehouseLineSchema>;

/**
 * Тело `PATCH /api/cells/:id`.
 *
 * MVP — единственное поле `warehouseId`: привязка ячейки к складу или
 * её сброс (передать `null`). Дополнительные поля (`active` и т. п.)
 * сюда сознательно не входят, чтобы ручка осталась узкой и
 * предсказуемой (см. ADR-0019, `docs/api.md §15`).
 */
export const UpdateCellSchema = z
  .object({
    warehouseId: z
      .union([z.string().min(1), z.null()])
      .optional(),
  })
  .refine(
    (obj) => obj.warehouseId !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateCellDto = z.infer<typeof UpdateCellSchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/** Сжатая ссылка на склад (для CellDetailDto и пр.). */
export interface WarehouseLiteDto {
  id: string;
  name: string;
  code: string | null;
}

/** Сжатая запись о ячейке внутри карточки склада / списка. */
export interface WarehouseCellDto {
  id: string;
  code: string;
  qrCode: string;
  active: boolean;
  /** Готовый абсолютный URL печати QR ячейки (см. `/api/cells/:id/print`). */
  printUrl: string;
}

/** Сжатая запись о линии склада. */
export interface WarehouseLineDto {
  id: string;
  code: string;
  cellsCount: number;
  createdAt: string;
}

/** Карточка для списка `/admin/warehouses`. */
export interface WarehouseSummaryDto {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  /** Шаблон печатной формы наклейки (см. `Warehouse.labelTemplate`). */
  labelTemplate: string | null;
  cellsCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Карточка `GET /api/warehouses/:id` — со всеми привязанными ячейками. */
export interface WarehouseDetailDto extends WarehouseSummaryDto {
  cells: WarehouseCellDto[];
  lines: WarehouseLineDto[];
}

/**
 * Ответ `POST /api/warehouses/:id/lines` — созданная линия и
 * созданные в ней ячейки. Вернуть полный список — менеджер сразу видит
 * результат массовой операции, не дожидаясь повторного GET.
 */
export interface CreateWarehouseLineResultDto {
  line: WarehouseLineDto;
  cells: WarehouseCellDto[];
}

// ---------------------------------------------------------------------------
// Bulk print «Печать всех ячеек»
// ---------------------------------------------------------------------------

/**
 * Поддерживаемые форматы этикетки QR-ячейки. На MVP только один
 * вариант (38×58 мм горизонтально, QR слева + номер справа) —
 * стандартная термоэтикетка для маркировки полок/ячеек. Dropdown в
 * UI всё равно показывает «список из одного» — архитектура готова к
 * расширению (например, A6 для крупных стеллажей).
 *
 * Размер диктует только `@page`-правила в `cell-print.ts`. Контракт
 * payload для агента — обычный `GET /api/cells/:id/print`, который
 * рендерит ровно эту вёрстку.
 */
export const WAREHOUSE_LABEL_SIZES = ['38x58'] as const;
export type WarehouseLabelSize = (typeof WAREHOUSE_LABEL_SIZES)[number];

/** Лимит копий за один запуск — отсекает опечатки вроде «10000». */
export const WAREHOUSE_PRINT_CELLS_MAX_COPIES = 50;

/**
 * Тело `POST /api/warehouses/:id/print-cells`.
 *
 * Контракт:
 *   - `printerId` — обязательный выбор логического принтера
 *     (см. `docs/domain.md §17`); агент рядом с этим принтером
 *     заберёт job-ы из очереди.
 *   - `copies` — сколько копий каждой этикетки печатать (default 1,
 *     int ≥ 1 ≤ {@link WAREHOUSE_PRINT_CELLS_MAX_COPIES}).
 *   - `labelSize` — формат этикетки (default `38x58`). На MVP
 *     валидируется как enum, реальной логикой пока не используется
 *     (template один), но поле в схеме чтобы UI не пересобирать.
 */
export const PrintWarehouseCellsSchema = z.object({
  printerId: z.string().min(1, 'Выберите принтер'),
  copies: z
    .number()
    .int('Количество копий должно быть целым числом')
    .min(1, 'Минимум 1 копия')
    .max(
      WAREHOUSE_PRINT_CELLS_MAX_COPIES,
      `Слишком много копий за один раз (макс. ${WAREHOUSE_PRINT_CELLS_MAX_COPIES})`,
    )
    .optional()
    .default(1),
  labelSize: z.enum(WAREHOUSE_LABEL_SIZES).optional().default('38x58'),
});
export type PrintWarehouseCellsDto = z.infer<typeof PrintWarehouseCellsSchema>;

/**
 * Ответ `POST /api/warehouses/:id/print-cells`. Возвращаем сводку, а
 * не полный массив `PrintJobDto`: на типовом складе 100+ ячеек × 2
 * копии = 200 job-ов, и UI всё равно покажет только сводку «N
 * заданий поставлено в очередь принтера X».
 */
export interface PrintWarehouseCellsResultDto {
  warehouseId: string;
  printerId: string;
  /** Сколько ячеек уехало в печать (после сортировки/фильтрации). */
  cellsCount: number;
  /** Копий на каждую ячейку (как пришло в теле, но уже с дефолтом). */
  copies: number;
  /** Сколько `PrintJob` записей реально создано (`cellsCount * copies`). */
  jobsCreated: number;
  labelSize: WarehouseLabelSize;
}
