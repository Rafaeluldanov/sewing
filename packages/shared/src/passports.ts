/**
 * Контракты модуля «Паспорта изделия» (Шаг 5 MVP).
 *
 * Zod-схемы — источник истины для валидации запросов на API и форм
 * на web. `type`-алиасы выведены из схем, чтобы web и api жили на
 * одних и тех же DTO.
 *
 * Скоуп Шага 5:
 * - выпуск паспорта на операции деление кроя (`CUT_DIVISION`);
 * - размещение паспорта в одной ячейке;
 * - печатная форма + QR-код;
 * - агрегация раскроя по заказу через паспорта (без пошива/ОТК/упаковки).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Совпадает с `PassportStatus` в Prisma-схеме.
 *
 * - `CREATED`     — создан помощником, но ещё не двинулся;
 * - `IN_PROGRESS` — двинулся по операциям пошива (на Шаге 5 не используется);
 * - `PACKED`      — упакован, выпуск (на Шаге 5 не используется);
 * - `CANCELLED`   — отменён (на будущее).
 */
export const PASSPORT_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'PACKED',
  'CANCELLED',
] as const;
export const PassportStatusSchema = z.enum(PASSPORT_STATUSES);
export type PassportStatus = z.infer<typeof PassportStatusSchema>;

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

const DateStringSchema = z
  .string()
  .min(1, 'Дата обязательна')
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Некорректная дата',
  });

/**
 * Тело `POST /api/passports`.
 *
 * - `orderId`  — заказ, в рамках которого выпускается паспорт.
 * - `sizeId`   — размер; должен присутствовать в `OrderItem` заказа.
 * - `cutDate`  — дата фактического кроя.
 * - `qtyCut`   — количество физически раскроенных изделий (> 0,
 *                не сверх остатка плана).
 * - `rollNumber` — номер рулона ткани (свободная строка).
 * - `cutterId` — раскройщик, на которого записываем сдельное
 *                immediate-начисление (ADR-0005 §«Шаг 9»). PHASE 2
 *                STEP 3: поле опциональное на схеме, но backend
 *                требует его явно у не-CUTTER ролей (`CUTTER_ASSISTANT`,
 *                `SHOP_MANAGER`). Для creator с `role = CUTTER` поле
 *                можно не передавать — backend запишет паспорт на
 *                него самого. Старая опасная привязка к seed-учётке
 *                `login = 'cutter'` удалена.
 *
 * Цвет и изделие подставляются на сервере из заказа.
 */
export const CreatePassportSchema = z.object({
  orderId: z.string().min(1, 'orderId обязателен'),
  sizeId: z.string().min(1, 'sizeId обязателен'),
  cutDate: DateStringSchema,
  qtyCut: z
    .number({ invalid_type_error: 'qtyCut должен быть числом' })
    .int('qtyCut должен быть целым')
    .positive('qtyCut должен быть > 0'),
  rollNumber: z
    .string()
    .trim()
    .min(1, 'Номер рулона обязателен')
    .max(64, 'Номер рулона слишком длинный'),
  cutterId: z.string().min(1, 'cutterId обязателен').optional(),
});
export type CreatePassportDto = z.infer<typeof CreatePassportSchema>;

/**
 * Тело `POST /api/passports/:id/place`.
 *
 * Поддерживаем два варианта идентификации ячейки: по `cellId` (из
 * выпадающего списка) или `cellCode` (свободный ввод/скан, например `A1`).
 * Минимум одно поле должно быть заполнено.
 */
export const PlacePassportSchema = z
  .object({
    cellId: z.string().min(1).optional(),
    cellCode: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => Boolean(v.cellId || v.cellCode), {
    message: 'Укажите ячейку (cellId или cellCode)',
    path: ['cellCode'],
  });
export type PlacePassportDto = z.infer<typeof PlacePassportSchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

export interface CellLiteDto {
  id: string;
  code: string;
}

export interface CellSizeRowDto {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  quantity: number;
}

export interface CellWarehouseLiteDto {
  id: string;
  name: string;
  code: string | null;
}

export interface CellDetailDto extends CellLiteDto {
  active: boolean;
  qrCode: string;
  contents: CellSizeRowDto[];
  /**
   * Привязанный склад (см. `docs/domain.md §16`). `null`, если ячейка
   * ещё не назначена ни на один склад — на flow размещения паспорта
   * это никак не влияет.
   */
  warehouse: CellWarehouseLiteDto | null;
}

export interface PassportListItemDto {
  id: string;
  number: string;
  status: PassportStatus;
  cutDate: string; // ISO
  createdAt: string; // ISO
  qtyCut: number;
  qtyPlan: number;
  qtyDefect: number;
  qtyGood: number;
  rollNumber: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  currentCell: CellLiteDto | null;
  /**
   * Soft-route MVP: индекс текущего шага маршрута (`OrderRouteStep.index`,
   * 0-based). `null` — у заказа нет snapshot-а маршрута, либо паспорт
   * ещё ни разу не сканировался по операции из маршрута.
   * Поле — UI-подсказка; backend не использует его для enforcement.
   */
  currentRouteStepIndex: number | null;
}

/**
 * Сжатая ссылка «паспорт упакован в коробку». Появляется на Шаге 8;
 * `null`, если паспорт ещё не в коробке. Дублирует часть BoxLiteDto из
 * `@sewing/shared/packing`, но завязка на packing не делается, чтобы
 * не плодить циклические импорты в shared.
 */
export interface PassportBoxLiteDto {
  id: string;
  number: string;
  status: 'OPEN' | 'CLOSED';
}

/**
 * Soft-route MVP: компактный шаг маршрута для UI-подсказки на /work.
 * Дублирует часть `OrderRouteStepDto`, но без `id` — этого достаточно
 * фронту, чтобы отрисовать «Шаг N: Название» и сравнить `operationId`
 * с операцией активной смены. См. `docs/domain.md §«Маршруты производства»`.
 */
export interface PassportRouteStepLiteDto {
  index: number;
  operationId: string;
  operationCode: string;
  operationName: string;
}

/**
 * Soft-route MVP: подсказка по маршруту для отображения в /work
 * (модалка `PassportConfirmModal` и карточка активного кроя).
 *
 * Поля заполняются при наличии у заказа snapshot маршрута
 * (`OrderRouteStep[]`). Если snapshot пустой — `routeHint = null`.
 *
 * Семантика «expected» (зафиксировано в STEP 8 ТЗ MVP, см. также
 * `docs/flows.md §F4` и `docs/domain.md §18`):
 *   `expectedOperation = currentRouteStep.operation`. То же правило
 *   уже используется в `current-work-card.tsx` и оставлено единым,
 *   чтобы UI везде давал одну и ту же подсказку.
 *
 * `routeMismatchWithActiveShift` = `true` тогда и только тогда, когда:
 *   - есть `currentRouteStep` (паспорт реально стоит на каком-то шаге);
 *   - есть `activeShiftOperationId` (у сотрудника открыта смена);
 *   - они не совпадают.
 *
 * Backend НИКОГДА не использует `routeHint` для блокировок —
 * это исключительно read-only подсказка для оператора (без 409,
 * без disable-кнопок). См. ТЗ MVP §STEP 8.
 */
export interface PassportRouteHintDto {
  currentRouteStep: PassportRouteStepLiteDto | null;
  nextRouteStep: PassportRouteStepLiteDto | null;
  expectedOperationId: string | null;
  expectedOperationName: string | null;
  activeShiftOperationId: string | null;
  activeShiftOperationName: string | null;
  routeMismatchWithActiveShift: boolean;
}

export interface PassportDetailDto extends PassportListItemDto {
  qrCode: string;
  /** Готовая ссылка для печати (HTML). См. ADR-0010. */
  printUrl: string;
  color: string;
  orderId: string;
  orderNumber: string;
  productId: string;
  productName: string;
  cutterId: string;
  cutterName: string;
  creatorId: string;
  creatorName: string;
  /** Коробка, в которую паспорт был упакован (Шаг 8). `null` — ещё нет. */
  box: PassportBoxLiteDto | null;
  /**
   * Soft-route MVP: подсказка по маршруту заказа. `null`, если у
   * заказа нет snapshot маршрута. Поле справочное, без enforcement
   * (см. `PassportRouteHintDto`). Заполняется только в эндпоинтах,
   * где это уместно (`/passports/by-code`, `/passports/:id`); в
   * остальных DTO (issue/scan/complete) тоже отдаём — фронт может
   * безопасно игнорировать.
   */
  routeHint: PassportRouteHintDto | null;
}

/** Компактный ответ `POST /api/passports/:id/place`. */
export interface PassportPlacementResultDto {
  passport: PassportDetailDto;
  cell: CellDetailDto;
}
