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
 *
 * Обрезка не молчит (ревью K7): строка ведомости получает пометку
 * `buildCapNote` в `SalaryEntry.managerComment` (см. `SalaryService`),
 * подкрой — флаги `cappedByGuard` / `longerThanShift` в DTO
 * (`RecutService.toDto`), месячник в отчётах себестоимости — тот же
 * предел через `costs/shift-presence.ts` (F1-2).
 */
export const DEFAULT_SHIFT_WORKED_CAP_HOURS = 16;

/**
 * Предел секунд на одну смену/подкрой для расчёта денег.
 *
 * Один `findUnique` без try/catch: на свежей БД строки `default` нет —
 * это `null`, а не ошибка (ревью K7: ловить исключение внутри
 * `$transaction` бессмысленно — транзакция Postgres уже aborted, и
 * следующий запрос упадёт всё равно; колонка `shiftMaxDurationHours` на
 * проде с 31.08).
 */
export async function resolveShiftWorkedCapSeconds(
  tx: Prisma.TransactionClient | PrismaService,
): Promise<number> {
  const row = await tx.companySettings.findUnique({
    where: { id: 'default' },
    select: { shiftMaxDurationHours: true },
  });
  let hours = row?.shiftMaxDurationHours ?? 0;
  if (!Number.isFinite(hours) || hours <= 0) {
    hours = DEFAULT_SHIFT_WORKED_CAP_HOURS;
  }
  return hours * 3600;
}

/** `endedAt − startedAt` в секундах, не меньше 0. */
export function rawWorkedSeconds(startedAt: Date, endedAt: Date): number {
  return Math.max(
    0,
    Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
  );
}

/** `endedAt − startedAt` в секундах, не меньше 0 и не больше предела. */
export function cappedWorkedSeconds(
  startedAt: Date,
  endedAt: Date,
  capSeconds: number,
): number {
  return Math.min(capSeconds, rawWorkedSeconds(startedAt, endedAt));
}

/**
 * Пометка обрезанной строки ведомости (Аудит 13.09.2026, K7, ревью:
 * «обрезано предохранителем N ч (фактически M ч)»). Пишется в
 * `SalaryEntry.managerComment` автоматическим sync-ом и узнаётся по
 * префиксу `CAP_NOTE_PREFIX` — чтобы sync правил только свою пометку, а
 * не текст менеджера (ручная правка и так поднимает `editedManually`,
 * после чего sync строку не трогает; `reset` стирает комментарий и
 * пометка ставится заново).
 */
export const CAP_NOTE_PREFIX = 'Обрезано предохранителем';

export function buildCapNote(
  capSeconds: number,
  rawSeconds: number,
  extra?: string,
): string {
  const body = `предохранителем ${formatHours(capSeconds)} ч (фактически ${formatHours(rawSeconds)} ч)`;
  return extra ? `${extra}; обрезано ${body}` : `Обрезано ${body}`;
}

export function isCapNote(comment: string | null | undefined): boolean {
  if (!comment) return false;
  return comment.toLowerCase().includes(CAP_NOTE_PREFIX.toLowerCase());
}

/**
 * Что писать в `managerComment` при автоматическом sync-е:
 *   - `note` (обрезано) → пометка, если поле пустое или там наша прежняя
 *     пометка;
 *   - `null` (не обрезано) → стереть нашу прежнюю пометку, пустое оставить;
 *   - чужой текст → `undefined` = не трогать.
 */
export function mergeCapNote(
  existing: string | null | undefined,
  note: string | null,
): string | null | undefined {
  if (!existing || isCapNote(existing)) {
    if ((existing ?? null) === note) return undefined;
    return note;
  }
  return undefined;
}

function formatHours(seconds: number): string {
  const h = seconds / 3600;
  const rounded = Math.round(h * 10) / 10;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(1).replace('.', ',');
}
