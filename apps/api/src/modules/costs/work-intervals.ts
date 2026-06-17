/**
 * Чистый строитель интервалов реальной работы ОДНОГО сотрудника из его
 * потока событий паспортов. Выход кормит `apportionEmployeeTime`
 * (`time-apportionment.ts`), который делит нахлёсты между паспортами.
 *
 * Два пути «accept → complete», потому что в реальном флоу события
 * пишутся по-разному (проверено по эмиссии в `passports.service.ts`,
 * `qc.service.ts`, `packing.service.ts`):
 *
 *   1. ЯВНЫЙ ACCEPT — операции, которые рабочий «берёт» через смену
 *      (`issueToEmployee`): пишется `ISSUED_TO_EMPLOYEE` (accept) и затем
 *      `OPERATION_FINISHED` (complete) с тем же `operationId`. Сюда
 *      попадают швейные операции и окладные сменные (деление кроя,
 *      настил). Интервал = `[ISSUE..COMPLETE]` точно.
 *
 *   2. ТОЛЬКО ТЕРМИНАЛ — ОТК/ВТО/упаковка: `ISSUED_TO_EMPLOYEE` не
 *      пишется, есть только `QC_PASSED` / `WTO_PASSED` / `PACKED`. Accept
 *      выводим «по разрыву»: время с предыдущего завершения этого же
 *      сотрудника (он был занят с тех пор), но не больше `capMs` (защита
 *      «забыл закрыть»/«ушёл на обед»). Самое первое завершение в потоке,
 *      когда предыдущего нет, считаем минимально (`minMs`) — иначе первый
 *      паспорт дня съел бы целый cap. Это обобщение текущей PACKING-эвристики
 *      (`PassportDurationsService.computePackingAccept`) на все терминальные
 *      окладные операции; заодно чинит ОТК/ВТО, чей accept раньше зависел
 *      от `OPERATION_SCAN`, которого в реальном флоу нет
 *      (см. `project_no_operation_scan_events`).
 *
 * Функция чистая и детерминированная — события передаются уже
 * нормализованными (`WorkEvent`), а cap/min — параметрами. Покрыта
 * unit-тестами (`tests/unit/work-intervals.test.ts`).
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
}

export interface BuildWorkIntervalsOptions {
  /** Потолок одного интервала, мс (защита «забыл закрыть»). */
  capMs: number;
  /** Минимальный интервал для самого первого терминала без accept, мс. */
  minMs: number;
}

/**
 * Строит интервалы работы сотрудника. Вход — события ОДНОГО сотрудника
 * (любой порядок, функция сортирует по времени).
 *
 * Пара `ISSUE→COMPLETE` матчится по `(passportId, operationId)`. Если
 * перед `COMPLETE` нет открытого `ISSUE` — применяется фолбэк по разрыву.
 */
export function buildWorkIntervals(
  events: WorkEvent[],
  options: BuildWorkIntervalsOptions,
): WorkInterval[] {
  const { capMs, minMs } = options;
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);

  // Открытые accept-ы по ключу passport|operation.
  const openIssue = new Map<string, number>();
  // Время предыдущего завершения этого сотрудника — для фолбэка по разрыву.
  let lastCompleteAt: number | null = null;

  const out: WorkInterval[] = [];

  for (const ev of sorted) {
    const key = `${ev.passportId} ${ev.operationId ?? ''}`;
    if (ev.kind === 'ISSUE') {
      // Свежий accept перетирает предыдущий незакрытый (перевыдача).
      openIssue.set(key, ev.atMs);
      continue;
    }

    // COMPLETE
    let startMs: number;
    const issuedAt = openIssue.get(key);
    if (issuedAt !== undefined && issuedAt < ev.atMs) {
      // Путь 1: точный accept из ISSUE.
      startMs = issuedAt;
      openIssue.delete(key);
    } else if (lastCompleteAt !== null) {
      // Путь 2: разрыв с предыдущего завершения, но не больше cap.
      startMs = Math.max(lastCompleteAt, ev.atMs - capMs);
    } else {
      // Путь 2, самый первый терминал в потоке — минимальный интервал.
      startMs = ev.atMs - minMs;
    }

    // Жёсткий cap на длину (на случай очень старого ISSUE).
    if (ev.atMs - startMs > capMs) {
      startMs = ev.atMs - capMs;
    }

    lastCompleteAt = ev.atMs;

    if (ev.atMs > startMs) {
      out.push({
        passportId: ev.passportId,
        operationId: ev.operationId,
        startMs,
        endMs: ev.atMs,
      });
    }
  }

  return out;
}
