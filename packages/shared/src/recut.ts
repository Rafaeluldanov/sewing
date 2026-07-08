/**
 * Контракты фичи «Подкрой» (роль `CUTTER`).
 *
 * См.:
 *   - `prisma/schema.prisma::RecutSession` + `SalaryEntrySource.RECUT`;
 *   - `apps/api/src/modules/recut/*`;
 *   - `apps/web/app/cutter/recut-panel.tsx` (+ `lib/recut-api.ts`).
 *
 * Что это:
 *   Подкрой — отдельная хронометрируемая активность раскройщика по
 *   заказу (докрой недостающих/бракованных деталей). Может понадобиться
 *   даже по уже ЗАВЕРШЁННОМУ заказу (`Order.status = DONE`). Не выпускает
 *   паспортов, не трогает статус/план заказа и не связан с `CuttingTask`
 *   — это просто таймер `start → stop`, привязанный к заказу и сотруднику.
 *
 * Поток:
 *   1. Раскройщик на смене (иначе доска `/cutter` закрыта) находит заказ
 *      поиском по номеру и жмёт «Начать подкрой» (`start` → `ACTIVE`).
 *   2. Идёт время. На доске — живой таймер.
 *   3. Жмёт «Завершить подкрой» (`complete` → `DONE`): фиксируется
 *      длительность и почасовая ДОПЛАТА сверх смены
 *      (`SalaryEntry(source=RECUT)`). Либо «Отменить» (`cancel` →
 *      `CANCELLED`, без оплаты).
 *
 * Zod-схемы здесь — источник истины для валидации: backend
 * (`RecutController`) и web (server action) валидируют ими обе стороны.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Статусы подкроя
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл подкроя. В БД хранится как `String` (без Prisma enum) —
 * расширение без миграции, тот же приём, что и `CuttingTask.status`.
 *
 *   ACTIVE ──complete──▶ DONE
 *      │
 *      └────cancel────▶ CANCELLED
 */
export const RECUT_SESSION_STATUSES = ['ACTIVE', 'DONE', 'CANCELLED'] as const;

export const RecutSessionStatusSchema = z.enum(RECUT_SESSION_STATUSES);
export type RecutSessionStatus = z.infer<typeof RecutSessionStatusSchema>;

export const RECUT_SESSION_STATUS_LABELS: Record<RecutSessionStatus, string> = {
  ACTIVE: 'Идёт',
  DONE: 'Завершён',
  CANCELLED: 'Отменён',
};

/** Тон бейджа статуса (совпадает с тонами `AdminStatusBadge`). */
export const RECUT_SESSION_STATUS_TONE: Record<
  RecutSessionStatus,
  'success' | 'info' | 'warning' | 'danger' | 'muted'
> = {
  ACTIVE: 'info',
  DONE: 'success',
  CANCELLED: 'muted',
};

// ---------------------------------------------------------------------------
// Запуск подкроя
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/recut/start`. `employeeId` НЕ передаётся — берётся из
 * сессии (ADR-0014). Заказ выбирается поиском по номеру; статус заказа
 * не проверяется — подкрой возможен и по завершённому заказу.
 */
export const StartRecutSchema = z.object({
  orderId: z.string().min(1),
});
export type StartRecutDto = z.infer<typeof StartRecutSchema>;

// ---------------------------------------------------------------------------
// DTO ответов
// ---------------------------------------------------------------------------

/** Заказ в результатах поиска для подкроя (узкая проекция). */
export interface RecutOrderSearchItemDto {
  id: string;
  number: string;
  status: string;
  /** Статус для человека (лейбл из `ORDER_STATUSES`), например «Завершён». */
  statusLabel: string;
  /** Клиент/контрагент, если задан. */
  clientName: string | null;
  /** Короткое описание изделия (первая позиция заказа), если есть. */
  productSummary: string | null;
}

/** Одна сессия подкроя (активная или завершённая). */
export interface RecutSessionDto {
  id: string;
  orderId: string;
  orderNumber: string;
  employeeId: string;
  employeeFullName: string | null;
  status: RecutSessionStatus;
  /** ISO-8601. Точка отсчёта живого таймера на клиенте. */
  startedAt: string;
  /** ISO-8601 или `null`, пока подкрой идёт. */
  endedAt: string | null;
  /** Отработанные секунды (проставляются при завершении). */
  workedSeconds: number | null;
  /** Снимок часовой ставки на момент завершения, ₽/ч. */
  ratePerHour: number | null;
  /** Рассчитанная доплата за подкрой, ₽. */
  amount: number | null;
}
