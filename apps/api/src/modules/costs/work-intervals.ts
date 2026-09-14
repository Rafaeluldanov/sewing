/**
 * Чистый строитель интервалов реальной работы ОДНОГО сотрудника из его
 * потока событий паспортов. Выход кормит `apportionEmployeeTime`
 * (`time-apportionment.ts`), который делит нахлёсты между паспортами.
 *
 * Правило одно (решение владельца 14.09.2026, «себестоимость по факту
 * выполненных работ»): интервал есть ТОЛЬКО там, где есть свой accept.
 *
 *   1. ЯВНЫЙ ACCEPT — операции, которые рабочий «берёт» через смену
 *      (`issueToEmployee`): пишется `ISSUED_TO_EMPLOYEE` (accept) и затем
 *      `OPERATION_FINISHED` (complete) с тем же `operationId`. Сюда
 *      попадают швейные операции окладниц и окладные сменные (деление
 *      кроя, «ВТО оклад», «крой оклад»). Интервал = `[ISSUE..COMPLETE]`
 *      точно; рамкой смены и делением нахлёстов занимается вызывающий
 *      код (`shift-frame.ts`, `time-apportionment.ts`).
 *
 *   2. ЗАВЕРШЕНИЕ БЕЗ ACCEPT — терминалы ОТК/ВТО/упаковки (`QC_PASSED`
 *      / `WTO_PASSED` / `PACKED`) и `OPERATION_FINISHED` без открытого
 *      `ISSUE` по своей паре. Интервала НЕ строим — такое завершение
 *      уходит в `unmatched`, и вызывающий код считает его по норме
 *      времени операции × объём паспорта (`operation-time-norm.ts`).
 *
 *      Почему не «по разрыву с предыдущего завершения», как было до
 *      14.09.2026: на проде между отметками ОТК проходило 7,7 мин
 *      (медиана) при p90 = 81 мин — в изделие ложился простой и обед
 *      контролёра. И не по скану `OPERATION_SCAN → QC_PASSED` (аудит
 *      13.09, F1-5): между сканом и «проверено» проходит 1 секунда
 *      (медиана) — контролёр отмечает партию уже после проверки, и
 *      хронометраж давал ноль. Норма × объём — единственная мера, которая
 *      отражает выполненную работу, а не привычку отмечаться.
 *
 * Функция чистая и детерминированная — события передаются уже
 * нормализованными (`WorkEvent`). Покрыта unit-тестами
 * (`tests/unit/work-intervals.test.ts`).
 */
import type { WorkInterval } from './time-apportionment.js';

/** Нормализованный тип события для строителя. */
export type WorkEventKind = 'ISSUE' | 'COMPLETE';

/** Одно событие из потока сотрудника (уже отфильтрованного по employeeId). */
export interface WorkEvent {
  passportId: string;
  /** Операция события (для COMPLETE из `*_PASSED`/`PACKED` может быть null). */
  operationId: string | null;
  kind: WorkEventKind;
  /** Время события, мс от epoch. */
  atMs: number;
  /**
   * Количество по событию (`PassportEvent.qty`, у терминалов = `qtyGood`
   * паспорта на момент отметки). Нужно только нормативной ветке —
   * строитель его не читает, а прокидывает в `unmatched` как есть.
   */
  qty?: number | null;
}

export interface BuiltWorkIntervals {
  /** Точные интервалы `[ISSUE..COMPLETE]` (путь 1). */
  intervals: WorkInterval[];
  /**
   * Завершения без своего accept (путь 2) — считать по норме × объём.
   * Порядок — по времени.
   */
  unmatched: WorkEvent[];
}

/**
 * Строит интервалы работы сотрудника. Вход — события ОДНОГО сотрудника
 * (любой порядок, функция сортирует по времени).
 *
 * Пара `ISSUE→COMPLETE` матчится по `(passportId, operationId)`. Свежий
 * `ISSUE` по той же паре перетирает незакрытый предыдущий (перевыдача).
 * `ISSUE` без завершения (паспорт ещё на руках) интервала не даёт.
 */
export function buildWorkIntervals(events: WorkEvent[]): BuiltWorkIntervals {
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);

  // Открытые accept-ы по ключу passport|operation.
  const openIssue = new Map<string, number>();

  const intervals: WorkInterval[] = [];
  const unmatched: WorkEvent[] = [];

  for (const ev of sorted) {
    const key = `${ev.passportId} ${ev.operationId ?? ''}`;
    if (ev.kind === 'ISSUE') {
      openIssue.set(key, ev.atMs);
      continue;
    }

    const issuedAt = openIssue.get(key);
    if (issuedAt !== undefined && issuedAt < ev.atMs) {
      openIssue.delete(key);
      intervals.push({
        passportId: ev.passportId,
        operationId: ev.operationId,
        startMs: issuedAt,
        endMs: ev.atMs,
      });
      continue;
    }
    // Accept в ту же миллисекунду, что и complete (или позже) — данных о
    // времени нет; открытый accept при этом снимаем, чтобы он не
    // «зачёлся» следующему завершению по той же паре.
    if (issuedAt !== undefined) openIssue.delete(key);
    unmatched.push(ev);
  }

  return { intervals, unmatched };
}
