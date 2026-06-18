/**
 * Контракты модуля «Маршруты производства» (production routes, MVP).
 *
 * См. `docs/domain.md §«Маршруты производства»`. На MVP это «soft route»:
 *   - менеджер создаёт `RouteTemplate` с упорядоченными шагами;
 *   - при создании заказа можно выбрать `routeTemplateId`;
 *   - при первом `OrdersService.start()` шаги фиксируются в snapshot
 *     `OrderRouteStep[]` (см. `OrderDetailDto.routeSteps`);
 *   - `Passport.currentRouteStepIndex` обновляется при scan-е операции,
 *     если она входит в маршрут;
 *   - НИКАКОГО enforcement: API не возвращает 409 за «не туда сканировал».
 *
 * Zod-схемы здесь — источник истины для валидации запросов на API и
 * клиентских форм; типы выведены из них.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

export const ROUTE_TEMPLATE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,47}$/;
export const ROUTE_TEMPLATE_CODE_MAX_LENGTH = 48;
export const ROUTE_TEMPLATE_NAME_MAX_LENGTH = 120;
export const ROUTE_TEMPLATE_MAX_STEPS = 200;
/** Потолок переопределения сдельной расценки (₽/шт) — защита от опечаток. */
export const ROUTE_STEP_RATE_OVERRIDE_MAX = 1_000_000;

/**
 * Переопределение сдельной расценки операции «для изделия»
 * (`RouteTemplateStep.rateOverride`). `null`/не задано — расценка по
 * дефолту операции. Деньги, поэтому ≤ 2 знака после запятой и ≥ 0.
 * Применяется только к операциям `pricingMode = FIXED` (бэкенд тихо
 * игнорирует override для BY_SIZE / SALARY_ONLY).
 */
const RouteStepRateOverrideField = z
  .number({ invalid_type_error: 'Расценка должна быть числом' })
  .nonnegative('Расценка не может быть отрицательной')
  .max(
    ROUTE_STEP_RATE_OVERRIDE_MAX,
    `Расценка не больше ${ROUTE_STEP_RATE_OVERRIDE_MAX} ₽`,
  )
  .refine(
    (v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9,
    'Расценка: не больше 2 знаков после запятой',
  )
  .nullable();

/** Потолок переопределения нормы времени (сек/шт) — ~11.5 суток, защита
 *  от опечаток. Совпадает с потолком `Operation.timeNormSec`. */
export const ROUTE_STEP_TIME_NORM_SEC_OVERRIDE_MAX = 1_000_000;

/**
 * Переопределение нормы времени операции (сек/шт) **в рамках заказа**
 * (`OrderRouteStep.timeNormSecOverride` для FIXED, либо
 * `OrderRouteStepSizeOverride.seconds` для BY_SIZE). `null` — норма по
 * дефолту операции. Целое число секунд ≥ 0; плановый контур (payroll не
 * читает).
 */
const RouteStepTimeNormSecOverrideField = z
  .number({ invalid_type_error: 'Норма времени должна быть числом' })
  .int('Норма времени: целое число секунд')
  .nonnegative('Норма времени не может быть отрицательной')
  .max(
    ROUTE_STEP_TIME_NORM_SEC_OVERRIDE_MAX,
    `Норма времени не больше ${ROUTE_STEP_TIME_NORM_SEC_OVERRIDE_MAX} сек`,
  )
  .nullable();

const RouteTemplateCodeField = z
  .string()
  .trim()
  .min(1, 'Код шаблона обязателен')
  .max(
    ROUTE_TEMPLATE_CODE_MAX_LENGTH,
    `Код шаблона не длиннее ${ROUTE_TEMPLATE_CODE_MAX_LENGTH} символов`,
  )
  .regex(
    ROUTE_TEMPLATE_CODE_PATTERN,
    'Код шаблона: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
  );

const RouteTemplateNameField = z
  .string()
  .trim()
  .min(1, 'Название шаблона обязательно')
  .max(
    ROUTE_TEMPLATE_NAME_MAX_LENGTH,
    `Название шаблона не длиннее ${ROUTE_TEMPLATE_NAME_MAX_LENGTH} символов`,
  );

/**
 * Один шаг шаблона в запросе на запись (POST/PATCH). `index` НЕ
 * обязателен — backend нормализует порядок по позиции элемента в
 * массиве (`steps[i].index = i`). Это упрощает UI: можно отдать просто
 * упорядоченный список без ручной нумерации. Если `index` всё-таки
 * передан, он игнорируется (см. `RoutesService.replaceSteps`).
 */
export const RouteTemplateStepInputSchema = z.object({
  operationId: z.string().min(1, 'operationId обязателен'),
  isOptional: z.boolean().optional().default(false),
  /**
   * «Этот шаг идёт параллельно с предыдущим» (взаимозаменяемы по
   * порядку). Backend сворачивает соседние шаги, связанные этим флагом,
   * в одну параллельную группу (`RouteTemplateStep.parallelGroup`):
   * порядок внутри группы любой, выход на следующий этап — когда все
   * шаги группы завершены. На первом шаге игнорируется. UI — тумблер
   * «↕ параллельно с соседним» в редакторе маршрута.
   */
  parallelWithPrev: z.boolean().optional().default(false),
  /**
   * Переопределение сдельной расценки операции для этого изделия
   * (`RouteTemplateStep.rateOverride`). `null`/не задано — берётся
   * дефолт `Operation.fixedRate`. Действует только для операций
   * `pricingMode = FIXED` (см. `OperationsService.resolveRate`).
   */
  rateOverride: RouteStepRateOverrideField.optional().default(null),
});
export type RouteTemplateStepInputDto = z.infer<
  typeof RouteTemplateStepInputSchema
>;

const StepsField = z
  .array(RouteTemplateStepInputSchema)
  .max(
    ROUTE_TEMPLATE_MAX_STEPS,
    `Максимум ${ROUTE_TEMPLATE_MAX_STEPS} шагов в шаблоне`,
  )
  .superRefine((steps, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < steps.length; i += 1) {
      const opId = steps[i].operationId;
      if (seen.has(opId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'operationId'],
          message: 'Операция не должна повторяться в маршруте',
        });
      }
      seen.add(opId);
    }
  });

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/routes`. На MVP `code` обязателен и уникален —
 * без авто-генерации (управленческий идентификатор задаёт менеджер).
 * `steps` могут быть пустыми, чтобы можно было создать «болванку»
 * шаблона и добить шаги отдельным PATCH-ом.
 */
export const CreateRouteTemplateSchema = z.object({
  code: RouteTemplateCodeField,
  name: RouteTemplateNameField,
  isActive: z.boolean().optional().default(true),
  steps: StepsField.default([]),
});
export type CreateRouteTemplateDto = z.infer<typeof CreateRouteTemplateSchema>;

/**
 * Тело `PATCH /api/routes/:id`. Все поля опциональны; передача `steps`
 * полностью заменяет набор шагов (см. `RoutesService.replaceSteps`).
 * Для частичного «вкл/выкл» — достаточно `{ isActive: ... }`.
 */
export const UpdateRouteTemplateSchema = z
  .object({
    code: RouteTemplateCodeField.optional(),
    name: RouteTemplateNameField.optional(),
    isActive: z.boolean().optional(),
    steps: StepsField.optional(),
  })
  .refine(
    (obj) =>
      obj.code !== undefined ||
      obj.name !== undefined ||
      obj.isActive !== undefined ||
      obj.steps !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateRouteTemplateDto = z.infer<typeof UpdateRouteTemplateSchema>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListRouteTemplatesQuerySchema = z.object({
  /**
   * `true`  — только активные (для UI выбора шаблона при создании заказа);
   * `false` — только неактивные;
   * не указан — все (для админа).
   */
  isActive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'boolean') return v;
      return v === 'true';
    }),
  search: z.string().trim().max(100).optional(),
});
export type ListRouteTemplatesQuery = z.infer<
  typeof ListRouteTemplatesQuerySchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface RouteTemplateStepDto {
  id: string;
  index: number;
  operationId: string;
  operationCode: string;
  operationName: string;
  isOptional: boolean;
  /**
   * Номер параллельной группы или `null`. Соседние шаги с одинаковым
   * ненулевым значением — взаимозаменяемый этап. Клиент выводит из этого
   * состояние тумблера «↕ параллельно с соседним»:
   * `parallelWithPrev = parallelGroup != null && parallelGroup === steps[i-1].parallelGroup`.
   */
  parallelGroup: number | null;
  /**
   * Переопределённая сдельная расценка операции для этого изделия
   * (₽/шт) или `null` (расценка по дефолту операции). Значимо только
   * для операций `pricingMode = FIXED`.
   */
  rateOverride: number | null;
}

export interface RouteTemplateSummaryDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  stepsCount: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface RouteTemplateDetailDto extends RouteTemplateSummaryDto {
  steps: RouteTemplateStepDto[];
}

/**
 * Снимок маршрута на конкретном заказе (поле `OrderDetailDto.routeSteps`).
 * Создаётся в `OrdersService.start()` из текущих шагов привязанного
 * шаблона; после snapshot-а правка шаблона не влияет на запущенные
 * заказы (см. `docs/domain.md §«Маршруты производства»`).
 */
export interface OrderRouteStepDto {
  id: string;
  index: number;
  operationId: string;
  operationCode: string;
  operationName: string;
  /** Снимок параллельной группы шага (см. `RouteTemplateStepDto`). */
  parallelGroup: number | null;
  /**
   * Переопределённая сдельная расценка операции (₽/шт) **в этом заказе**
   * или `null` (расценка по дефолту операции). Изначально снимок
   * `RouteTemplateStep.rateOverride`, далее редактируется прямо в заказе
   * (`PUT /api/orders/:id/route-overrides`). Действует для
   * `pricingMode = FIXED`.
   */
  rateOverride: number | null;
  /**
   * Переопределённая норма времени операции (сек/шт) **в этом заказе**
   * или `null` (норма по дефолту операции `Operation.timeNormSec`).
   * Действует для `timeNormMode = FIXED`. Плановый контур.
   */
  timeNormSecOverride: number | null;
  /**
   * Поразмерные переопределения расценки/нормы **в этом заказе** для
   * операций `pricingMode = BY_SIZE` / `timeNormMode = BY_SIZE`. Пустой
   * массив — переопределений нет.
   */
  sizeOverrides: OrderRouteStepSizeOverrideDto[];
}

/**
 * Поразмерное переопределение расценки/нормы операции в рамках заказа
 * (снимок `OrderRouteStepSizeOverride`). `null` в поле — по этому размеру
 * переопределения нет, берётся дефолт операции.
 */
export interface OrderRouteStepSizeOverrideDto {
  sizeId: string;
  /** Переопределённая ставка ₽/шт для размера (`pricingMode = BY_SIZE`). */
  rate: number | null;
  /** Переопределённая норма сек/шт для размера (`timeNormMode = BY_SIZE`). */
  seconds: number | null;
}

// ---------------------------------------------------------------------------
// Per-order route overrides — запись (PUT /api/orders/:id/route-overrides)
// ---------------------------------------------------------------------------

/**
 * Поразмерный оверрайд в запросе. `rate`/`seconds` = `null` снимает
 * переопределение по этому размеру.
 */
export const OrderRouteStepSizeOverrideInputSchema = z.object({
  sizeId: z.string().min(1, 'sizeId обязателен'),
  rate: RouteStepRateOverrideField.optional().default(null),
  seconds: RouteStepTimeNormSecOverrideField.optional().default(null),
});
export type OrderRouteStepSizeOverrideInputDto = z.infer<
  typeof OrderRouteStepSizeOverrideInputSchema
>;

/**
 * Один шаг снимка маршрута заказа в запросе на правку оверрайдов.
 * Адресуется по `stepId` (`OrderRouteStep.id`). Все поля переопределений
 * опциональны; не переданное поле трактуется как «оставить без
 * изменения» на бэкенде (см. `OrdersService.updateRouteOverrides`).
 */
export const OrderRouteStepOverrideInputSchema = z.object({
  stepId: z.string().min(1, 'stepId обязателен'),
  rateOverride: RouteStepRateOverrideField.optional(),
  timeNormSecOverride: RouteStepTimeNormSecOverrideField.optional(),
  sizeOverrides: z
    .array(OrderRouteStepSizeOverrideInputSchema)
    .max(200, 'Слишком много поразмерных строк')
    .optional(),
});
export type OrderRouteStepOverrideInputDto = z.infer<
  typeof OrderRouteStepOverrideInputSchema
>;

/**
 * Тело `PUT /api/orders/:id/route-overrides` — правки расценок/норм
 * операций в рамках заказа (режим «Редактировать маршрут заказа» →
 * «Сохранить всё»). Не трогает справочник `Operation` и шаблон маршрута.
 */
export const UpdateOrderRouteOverridesSchema = z.object({
  steps: z
    .array(OrderRouteStepOverrideInputSchema)
    .max(ROUTE_TEMPLATE_MAX_STEPS, `Максимум ${ROUTE_TEMPLATE_MAX_STEPS} шагов`),
});
export type UpdateOrderRouteOverridesDto = z.infer<
  typeof UpdateOrderRouteOverridesSchema
>;
