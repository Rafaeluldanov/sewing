/**
 * Контракты модуля «Операции» (управленческий блок).
 *
 * Источник истины — backend (`/api/operations`). Введён вместе с
 * экраном `/admin/operations` (см. `docs/domain.md §16a`,
 * `docs/api.md §15a`, `docs/screens.md §10c`).
 *
 * Скоуп MVP сознательно ограничен:
 *   - три тарифных режима (FIXED | BY_SIZE | SALARY_ONLY);
 *   - для FIXED — одна ставка `fixedRate`;
 *   - для BY_SIZE — таблица `(sizeId, rate)`;
 *   - для SALARY_ONLY — ставка не задаётся и не используется
 *     `EarningsService`.
 *
 * За рамками MVP (сознательно):
 *   - история ставок по датам;
 *   - ставки по сотруднику / складу / селлеру;
 *   - матрица «продукт × размер».
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

export const PRICING_MODES = ['FIXED', 'BY_SIZE', 'SALARY_ONLY'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export const OPERATION_CATEGORIES = [
  'CUTTING',
  'SEWING',
  'QC',
  'IRONING',
  'PACKING',
] as const;
export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Денежная ставка `Decimal(12,2)` в виде числа. Принимаем `number`
 * или строку (форма легко отдаёт строки), нормализуем до неотрицательного
 * с двумя знаками после запятой. Защита от NaN/Infinity и слишком
 * больших значений (16-bit money — это ~99999.99, нам с запасом хватит
 * `< 10_000_000`, что укладывается в `Decimal(12,2)`).
 */
const RateField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка должна быть числом',
      });
      return z.NEVER;
    }
    if (num < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка не может быть отрицательной',
      });
      return z.NEVER;
    }
    if (num >= 10_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка слишком большая',
      });
      return z.NEVER;
    }
    return Math.round(num * 100) / 100;
  });

const CodeField = z
  .string()
  .trim()
  .min(1, 'Код операции обязателен')
  .max(64, 'Код слишком длинный (макс. 64 символа)')
  .regex(
    /^[A-Z0-9_]+$/,
    'Код операции — только латинские заглавные буквы, цифры и подчёркивание',
  );

const NameField = z
  .string()
  .trim()
  .min(1, 'Название операции обязательно')
  .max(120, 'Название слишком длинное');

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/operations`.
 *
 * Принципы валидации:
 *   - `pricingMode` обязателен — менеджер выбирает «как платить»
 *     явно, чтобы UI/backend не угадывали;
 *   - для `FIXED` обязателен `fixedRate`; для `BY_SIZE` принимаем
 *     опциональный `ratesBySize`, чтобы можно было одной ручкой
 *     создать операцию вместе со ставками; для `SALARY_ONLY` —
 *     ничего из ставок не принимаем.
 */
export const CreateOperationSchema = z
  .object({
    code: CodeField,
    name: NameField,
    category: z.enum(OPERATION_CATEGORIES),
    pricingMode: z.enum(PRICING_MODES),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    fixedRate: RateField.optional(),
    ratesBySize: z
      .array(
        z.object({
          sizeId: z.string().min(1, 'sizeId обязателен'),
          rate: RateField,
        }),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pricingMode === 'FIXED') {
      if (data.fixedRate === undefined) {
        ctx.addIssue({
          path: ['fixedRate'],
          code: z.ZodIssueCode.custom,
          message: 'Для FIXED укажите фиксированную ставку',
        });
      }
      if (data.ratesBySize && data.ratesBySize.length > 0) {
        ctx.addIssue({
          path: ['ratesBySize'],
          code: z.ZodIssueCode.custom,
          message:
            'Для FIXED ставки по размерам не задаются — используйте fixedRate',
        });
      }
    }
    if (data.pricingMode === 'BY_SIZE') {
      if (data.fixedRate !== undefined) {
        ctx.addIssue({
          path: ['fixedRate'],
          code: z.ZodIssueCode.custom,
          message:
            'Для BY_SIZE fixedRate не используется — задайте ставки по размерам',
        });
      }
    }
    if (data.pricingMode === 'SALARY_ONLY') {
      if (data.fixedRate !== undefined) {
        ctx.addIssue({
          path: ['fixedRate'],
          code: z.ZodIssueCode.custom,
          message: 'Для SALARY_ONLY ставка не задаётся',
        });
      }
      if (data.ratesBySize && data.ratesBySize.length > 0) {
        ctx.addIssue({
          path: ['ratesBySize'],
          code: z.ZodIssueCode.custom,
          message: 'Для SALARY_ONLY ставки по размерам не задаются',
        });
      }
    }
  });
export type CreateOperationDto = z.infer<typeof CreateOperationSchema>;

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

/**
 * Тело `PATCH /api/operations/:id`.
 *
 * Любое поле опционально, но хотя бы одно должно прийти. Смена
 * `pricingMode` разрешена и обрабатывается атомарно:
 *   - `FIXED` ← *: сервис очищает `OperationRateBySize` и проставляет
 *     `fixedRate`;
 *   - `BY_SIZE` ← *: `fixedRate` обнуляется; если в теле передан
 *     `ratesBySize` — он перезаписывает таблицу (см.
 *     `OperationsService.update`);
 *   - `SALARY_ONLY` ← *: `fixedRate` и все `OperationRateBySize`
 *     очищаются.
 *
 * Отдельная массовая загрузка ставок по размерам — там же, в этом
 * PATCH (через `ratesBySize`); это сознательно, чтобы менеджер мог
 * одной кнопкой «Сохранить» применить весь экран. Отдельной ручки
 * `PATCH /api/operations/:id/rates` не делаем (см. ADR в комментарии
 * `docs/domain.md §16a`).
 */
export const UpdateOperationSchema = z
  .object({
    name: NameField.optional(),
    category: z.enum(OPERATION_CATEGORIES).optional(),
    pricingMode: z.enum(PRICING_MODES).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    /** `null` → очистить fixedRate (валидно только при `FIXED → *`). */
    fixedRate: z.union([RateField, z.null()]).optional(),
    /**
     * Полный набор ставок по размерам (replace-all, не merge).
     * `[]` явно очищает все ставки (полезно при переходе из BY_SIZE
     * в FIXED/SALARY_ONLY одной транзакцией). Уникальность `sizeId`
     * валидируется бэкендом — проще держать массив на клиенте.
     */
    ratesBySize: z
      .array(
        z.object({
          sizeId: z.string().min(1, 'sizeId обязателен'),
          rate: RateField,
        }),
      )
      .optional(),
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.category !== undefined ||
      obj.pricingMode !== undefined ||
      obj.isActive !== undefined ||
      obj.sortOrder !== undefined ||
      obj.fixedRate !== undefined ||
      obj.ratesBySize !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateOperationDto = z.infer<typeof UpdateOperationSchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface OperationRateBySizeDto {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  /** Ставка за единицу (число, две цифры после запятой). */
  rate: number;
}

/** Сжатый список для экрана `/admin/operations`. */
export interface OperationSummaryDto {
  id: string;
  code: string;
  name: string;
  category: OperationCategory;
  pricingMode: PricingMode;
  /** Для FIXED — собственно ставка; для BY_SIZE/SALARY_ONLY — `null`. */
  fixedRate: number | null;
  /** Для BY_SIZE — сколько строк ставок задано; иначе `0`. */
  ratesBySizeCount: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Карточка операции `GET /api/operations/:id`. */
export interface OperationDetailDto extends OperationSummaryDto {
  /** Полный список ставок по размерам (для BY_SIZE; иначе пустой). */
  ratesBySize: OperationRateBySizeDto[];
  /**
   * Все размеры из справочника, отсортированные по `sortOrder`.
   * Удобно для UI: один источник истины «какие размеры существуют»,
   * чтобы фронт не делал отдельный запрос к `/catalog/sizes`.
   */
  sizes: Array<{ id: string; code: string; sortOrder: number }>;
}
