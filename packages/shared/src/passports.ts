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
 *
 * Цвет, изделие и `cutterId` подставляются на сервере из заказа /
 * демо-окружения (на этапе без аутентификации, см. ADR-0010).
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
}

/** Компактный ответ `POST /api/passports/:id/place`. */
export interface PassportPlacementResultDto {
  passport: PassportDetailDto;
  cell: CellDetailDto;
}
