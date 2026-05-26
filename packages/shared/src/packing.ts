/**
 * Контракты Шага 8 MVP: ВТО + упаковка + выпуск изделия.
 *
 * Zod-схемы — источник истины для валидации запросов на API и форм
 * на web. `type`-алиасы выведены из схем, чтобы web и api жили на
 * одних и тех же DTO.
 *
 * Скоуп Шага 8:
 * - ВТО проходит обычным сканом (`POST /api/passports/:id/scan`) на
 *   активной смене с операцией `WTO`. Отдельного API/экрана у ВТО на
 *   MVP нет — см. `docs/flows.md §F6` и ADR-0011.
 * - упаковка: коробки, добавление паспортов, выпуск изделия
 *   (`Passport.status = PACKED`, агрегаты заказа `qtyFinished`).
 *
 * За рамками Шага 8: split/merge коробок, возврат паспорта из коробки
 * назад в производство, shipment/склад готовой продукции, печать
 * этикеток PDF, интеграция с 1С/WB, расчёт зарплаты упаковщика
 * (оклад) и апрув начислений швеи (Шаг 9), экран «Цех».
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Box status (derived)
// ---------------------------------------------------------------------------

/**
 * Логический статус коробки. В БД хранится только `closedAt` — статус
 * вычисляется (`OPEN` если `closedAt IS NULL`, иначе `CLOSED`). Так
 * сохраняем минимум полей в `Box` и не плодим дополнительные enum-ы.
 */
export const BOX_STATUSES = ['OPEN', 'CLOSED'] as const;
export const BoxStatusSchema = z.enum(BOX_STATUSES);
export type BoxStatus = z.infer<typeof BoxStatusSchema>;

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/packing/boxes`.
 *
 * `maxQty` опционален и существует только для обратной совместимости
 * со старыми клиентами: упаковщик его больше не задаёт, capacity-чек
 * в `PackingService.addPassport` снят, в БД пишется default
 * `Box.maxQty = 100` для исторических данных.
 */
export const CreateBoxSchema = z.object({
  maxQty: z
    .number({ invalid_type_error: 'maxQty должен быть числом' })
    .int('maxQty должен быть целым')
    .positive('maxQty должен быть > 0')
    .optional(),
});
export type CreateBoxDto = z.infer<typeof CreateBoxSchema>;

/**
 * Тело `POST /api/packing/boxes/:id/add-passport`.
 *
 * Поддерживаем два варианта идентификации паспорта: по `passportId`
 * (если фронт уже разрезолвил QR) или `code` (свободный ввод/скан).
 * Минимум одно поле должно быть заполнено.
 */
export const AddPassportToBoxSchema = z
  .object({
    passportId: z.string().min(1).optional(),
    code: z.string().trim().min(1).max(128).optional(),
  })
  .refine((v) => Boolean(v.passportId || v.code), {
    message: 'Укажите паспорт (passportId или code)',
    path: ['code'],
  });
export type AddPassportToBoxDto = z.infer<typeof AddPassportToBoxSchema>;

/** Тело `POST /api/packing/boxes/:id/close` — пустое (исполнитель из сессии). */
export const CloseBoxSchema = z.object({}).strict();
export type CloseBoxDto = z.infer<typeof CloseBoxSchema>;

/**
 * Тело `POST /api/packing/boxes/:id/place`. Размещает закрытую коробку
 * в ячейку склада — после этого она исчезает из списка «ждут
 * размещения» в терминале упаковщика.
 *
 * Принимает либо `cellId` (id ячейки), либо `code` (свободный код или
 * QR-payload `cell:<id>`). Достаточно одного.
 */
export const PlaceBoxSchema = z
  .object({
    cellId: z.string().min(1).optional(),
    code: z.string().trim().min(1).max(128).optional(),
  })
  .refine((v) => Boolean(v.cellId || v.code), {
    message: 'Укажите ячейку (cellId или code)',
    path: ['code'],
  });
export type PlaceBoxDto = z.infer<typeof PlaceBoxSchema>;

// ---------------------------------------------------------------------------
// Query DTO
// ---------------------------------------------------------------------------

export const ListBoxesQuerySchema = z.object({
  /** `OPEN` — только незакрытые; `CLOSED` — только закрытые; иначе обе. */
  status: BoxStatusSchema.optional(),
  /**
   * Фильтр по факту размещения коробки в ячейку склада. `true` —
   * только размещённые (`placedAt IS NOT NULL`); `false` — только
   * не размещённые (`placedAt IS NULL`); если не указан — обе.
   * Используется на Stage 1 терминала упаковщика, чтобы показать
   * «закрыты, но ещё не размещены».
   */
  placed: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListBoxesQuery = z.infer<typeof ListBoxesQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Сжатая ссылка «паспорт лежит в коробке» — для отрисовки на
 * `/passports/[id]` и в списках. Совпадает по форме с `CellLiteDto`,
 * но смыслово другое.
 */
export interface BoxLiteDto {
  id: string;
  number: string;
  status: BoxStatus;
}

/** Один элемент коробки (паспорт + сколько штук учтено упаковкой). */
export interface BoxItemDto {
  id: string;
  passportId: string;
  passportNumber: string;
  productName: string;
  color: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qty: number;
  orderId: string;
  orderNumber: string;
  createdAt: string; // ISO
}

/** Сжатая строка списка коробок (`GET /api/packing/boxes`). */
export interface BoxListItemDto {
  id: string;
  number: string;
  qrCode: string;
  status: BoxStatus;
  totalQty: number;
  maxQty: number;
  itemsCount: number;
  createdAt: string; // ISO
  closedAt: string | null;
  createdById: string;
  createdByName: string;
  /** ISO момента размещения коробки в ячейку. `null` — ещё не размещена. */
  placedAt: string | null;
  /**
   * Ячейка, в которую размещена коробка. `null`, если ещё не размещена
   * либо ячейка была удалена (FK `onDelete: SetNull`, см.
   * `prisma/schema.prisma::Box`).
   */
  placedInCell: { id: string; code: string } | null;
}

/** Карточка коробки (`GET /api/packing/boxes/:id`). */
export interface BoxDetailDto extends BoxListItemDto {
  items: BoxItemDto[];
  /**
   * Сводка по содержимому: одно изделие/цвет/размер на MVP (см. ADR-0011),
   * поэтому достаточно одной строки. `null`, если коробка пустая.
   */
  summary: {
    productName: string;
    color: string;
    sizeId: string;
    sizeCode: string;
  } | null;
  /** Готовая ссылка для печати этикетки (HTML). По аналогии с `Passport.printUrl`. */
  labelUrl: string;
}

export interface BoxesPage {
  items: BoxListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}
