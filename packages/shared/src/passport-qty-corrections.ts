/**
 * Контракты модуля «Корректировка фактического количества по паспорту».
 *
 * Доменная модель: ОТК на `/qc` предлагает новое фактическое количество
 * по паспорту (`qtyAfter`), мастер цеха (`SHOPFLOOR_MASTER`) на `/master`
 * подтверждает или отклоняет. После `APPROVED` backend двигает
 * `Passport.qtyCut`/`qtyGood` на разницу, пересчитывает сдельную ЗП
 * (швеи + раскройщик), пишет `PassportEvent(QTY_CORRECTED)`. См.
 * `apps/api/src/modules/passport-qty-corrections/*`,
 * `model PassportQtyCorrection` в Prisma.
 *
 * Zod-схемы — источник истины для валидации запросов API и форм UI.
 * `type`-алиасы выведены из схем, чтобы web и api жили на одних DTO.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Status enum (совпадает с PassportQtyCorrectionStatus в Prisma)
// ---------------------------------------------------------------------------

export const PASSPORT_QTY_CORRECTION_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;
export const PassportQtyCorrectionStatusSchema = z.enum(
  PASSPORT_QTY_CORRECTION_STATUSES,
);
export type PassportQtyCorrectionStatus = z.infer<
  typeof PassportQtyCorrectionStatusSchema
>;

export const PASSPORT_QTY_CORRECTION_STATUS_LABELS: Record<
  PassportQtyCorrectionStatus,
  string
> = {
  PENDING: 'Ждёт мастера',
  APPROVED: 'Подтверждена',
  REJECTED: 'Отклонена',
};

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/qc/passports/:id/qty-corrections`.
 *
 * - `qtyAfter` — новое фактическое количество (можно и больше, и
 *   меньше текущего). Неотрицательное целое; верхнюю границу backend
 *   проверяет по паспорту (`qtyCut` не может уйти ниже `qtyDefect`).
 * - `reason` — короткая причина, НЕОБЯЗАТЕЛЬНА (до 280 символов).
 */
export const CreatePassportQtyCorrectionSchema = z.object({
  qtyAfter: z
    .number({ invalid_type_error: 'Укажите количество' })
    .int('Количество должно быть целым')
    .min(0, 'Количество не может быть отрицательным'),
  reason: z.string().trim().max(280).optional(),
});
export type CreatePassportQtyCorrectionDto = z.infer<
  typeof CreatePassportQtyCorrectionSchema
>;

/**
 * Тело `POST /api/master-qty-corrections/:id/approve|reject`. Мастер
 * может приложить короткую заметку (особенно при отклонении).
 */
export const ReviewPassportQtyCorrectionSchema = z.object({
  note: z.string().trim().max(280).optional(),
});
export type ReviewPassportQtyCorrectionDto = z.infer<
  typeof ReviewPassportQtyCorrectionSchema
>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/** Карточка заявки на корректировку (для очереди мастера и карточки ОТК). */
export interface PassportQtyCorrectionDto {
  id: string;
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizeCode: string;
  status: PassportQtyCorrectionStatus;
  /** Снимок `qtyGood` на момент подачи. */
  qtyBefore: number;
  /** Новое фактическое количество. */
  qtyAfter: number;
  /** `qtyAfter − qtyBefore` (может быть отрицательной). */
  delta: number;
  reason: string | null;
  reviewerNote: string | null;
  requestedByEmployeeId: string;
  requestedByEmployeeName: string;
  requestedAt: string; // ISO
  reviewedByEmployeeId: string | null;
  reviewedByEmployeeName: string | null;
  reviewedAt: string | null; // ISO
}

/**
 * Результат подтверждения корректировки. Помимо самой заявки отдаёт
 * итоговые количества и сводку по пересчёту ЗП, чтобы UI мастера мог
 * показать «N строк ЗП обновлено, M уже выплачено — разобрать вручную».
 */
export interface ApprovePassportQtyCorrectionResultDto {
  correction: PassportQtyCorrectionDto;
  qtyCut: number;
  qtyGood: number;
  /** Сколько строк `OperationEntry` пересчитано (швеи + раскройщик). */
  salaryAdjusted: number;
  /** Сколько строк пропущено, т.к. уже попали в выплату (`PayrollPayoutLine`). */
  salarySkipped: number;
}
