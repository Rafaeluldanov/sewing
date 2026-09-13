import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Предохранитель для часов ОДНОЙ смены / ОДНОГО подкроя в деньгах
 * ведомости (Аудит движка расчёта 13.09.2026, K7 и G4-3).
 *
 * Забытую смену закрывают кнопкой «Завершить смену» на следующий день
 * (или через N суток), и `endedAt − startedAt` даёт 24,5 / 73 / 1 643 ч —
 * повременка (`SHIFT_DAY`) платила их целиком. Автозакрытие смен
 * (`shift-auto-close.ts`) опционально, по умолчанию выключено, ручной
 * `stop` его порог не применяет, а уже закрытые смены оно не правит.
 * Поэтому граница стоит там, где считаются деньги: длительность одной
 * закрытой смены (и одного подкроя, см. `RecutService`) в расчёте не
 * может превышать предел. Сама `ShiftSession` не меняется — табель
 * мастера и аналитика видят настоящую длительность.
 *
 * Предел = `CompanySettings.shiftMaxDurationHours` (тот же порог, что у
 * автозакрытия: «смена не может быть дольше N часов»), а если он не
 * задан (`0`) — `DEFAULT_SHIFT_WORKED_CAP_HOURS`. Новых полей в схеме
 * нет. Прецедент в проекте — `MAX_STAGE_MINUTES_PER_PASSPORT`
 * («защита от „забыл закрыть“») в `packages/shared/src/costs.ts`.
 */
export const DEFAULT_SHIFT_WORKED_CAP_HOURS = 16;

/** Предел секунд на одну смену/подкрой для расчёта денег. */
export async function resolveShiftWorkedCapSeconds(
  tx: Prisma.TransactionClient | PrismaService,
): Promise<number> {
  let hours = 0;
  try {
    const row = await tx.companySettings.findUnique({
      where: { id: 'default' },
      select: { shiftMaxDurationHours: true },
    });
    hours = row?.shiftMaxDurationHours ?? 0;
  } catch {
    // fail-soft: на свежей БД строки нет, между деплоем и миграцией
    // нет колонки — работает предел по умолчанию.
    hours = 0;
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    hours = DEFAULT_SHIFT_WORKED_CAP_HOURS;
  }
  return hours * 3600;
}

/** `endedAt − startedAt` в секундах, не меньше 0 и не больше предела. */
export function cappedWorkedSeconds(
  startedAt: Date,
  endedAt: Date,
  capSeconds: number,
): number {
  const raw = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);
  return Math.min(capSeconds, Math.max(0, raw));
}
