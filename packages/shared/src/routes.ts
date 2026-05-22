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
}
