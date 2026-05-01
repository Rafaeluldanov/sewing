/**
 * `admin-analytics.ts` — KPI / heatmap / bottleneck helpers (Admin Analytics).
 *
 * Чистые функции (без сетевых вызовов, без React) для верхнего блока
 * «Сегодня в производстве» на `/admin`. Источник данных — те же DTO,
 * что использует `/shopfloor/display` (`ShopfloorDisplayDto`) и модуль
 * вызовов мастера (`MasterCallDto`). Backend здесь специально не
 * расширяется: на ТЗ требовалось обойтись существующими API.
 *
 * Эвристики намеренно мягкие и совпадают с теми, что
 * `display-board.tsx` использует для подсветки цеха:
 *   - bottleneck = sewing-операция с максимальным `done` буфером,
 *     если этот буфер ≥ `BOTTLENECK_BUFFER_THRESHOLD` (≥ 10 шт);
 *   - «следующая операция после bottleneck» считается узким местом
 *     потока — по ней ждёт самый большой WIP в маршруте.
 *
 * Heatmap собирается из четырёх источников в маршруте передела:
 *   1. CUT (qtyCut)         — крой, ждёт швею;
 *   2. sewing-операции      — ▶ inProgress + ✔ done из `sewingRoute`;
 *   3. QC / QC_DONE         — ▶ qtyQc + ✔ qtyQcDone;
 *   4. WTO / WTO_DONE       — ▶ qtyWto + ✔ qtyWtoDone;
 *   5. PACKING (qtyPacking) — открытые коробки;
 *   6. FINISHED (qtyFinished) — закрытая упаковка за период.
 *
 * Эти числа точно те же, что менеджер видит на `/shopfloor/display` —
 * мы не вводим новой агрегации, только перепаковываем под heatmap-чипы.
 */

import type {
  MasterCallDto,
  MasterCallStatus,
} from '@sewing/shared/master-calls';
import type { ShopfloorDisplayDto } from '@sewing/shared/shopfloor';

/**
 * Насыщенность одной ячейки heatmap'а. Цветовые градации описаны в
 * `globals.css` (`.admin-heatmap__chip--*`). Совпадение «коралл =
 * bottleneck» намеренное: красный/оранжевый на дисплее уже занят
 * под мигание узких мест в цехе, поэтому в админке узкое место
 * подаётся отдельным более тёплым тоном, чтобы не путать с обычным
 * WIP > 30.
 */
export type HeatmapTone = 'muted' | 'blue' | 'green' | 'orange' | 'coral';

export interface AdminKpi {
  id: string;
  /** Подпись «крупно» под значением. */
  label: string;
  /** Готовое к показу строковое значение (число → toLocaleString). */
  value: string;
  /** Небольшая подпись под значением (необязательно). */
  hint?: string;
  /** Цветовой акцент карточки. */
  tone: 'blue' | 'green' | 'orange' | 'purple' | 'coral';
  /** Сырое числовое значение (для тестов и сортировок). */
  raw: number | null;
}

export interface HeatmapCell {
  /** Стабильный ключ ячейки (для React-list'а). */
  key: string;
  /** Подпись операции на UI («Крой», «Оверлок 01», «ОТК» …). */
  label: string;
  /** ▶ — сейчас в работе (физически на этой операции). */
  inProgress: number;
  /** ✔ — завершено и ждёт следующую операцию (буфер). */
  done: number;
  /** total = inProgress + done. */
  total: number;
  /** Цветовая градация по эвристике из `pickHeatmapTone`. */
  tone: HeatmapTone;
  /** `true`, если эта операция определена как узкое место маршрута. */
  isBottleneck: boolean;
}

/** Порог буфера, начиная с которого операция считается «узким местом». */
export const BOTTLENECK_BUFFER_THRESHOLD = 10;

/**
 * Классифицируем «общую загруженность» операции по total = ▶ + ✔.
 * Если у операции вообще ничего нет — muted, чтобы не визуально не
 * соревновалась с активными чипами.
 */
function pickHeatmapTone(total: number): HeatmapTone {
  if (total <= 0) return 'muted';
  if (total < 10) return 'blue';
  if (total < 30) return 'green';
  return 'orange';
}

/**
 * Сумма `inProgress` (или `done`) по всем размерам блока маршрута.
 */
function sumRouteOperationField(
  rows: ReadonlyArray<{ inProgress: number; done: number }>,
  field: 'inProgress' | 'done',
): number {
  let acc = 0;
  for (const r of rows) acc += r[field] ?? 0;
  return acc;
}

/**
 * Определяет «узкое место» по тому же правилу, что и display:
 * максимальный буфер ✔ среди sewing-операций, если он не меньше
 * `BOTTLENECK_BUFFER_THRESHOLD`. Возвращает индекс операции в
 * `display.sewingRoute` или `null`.
 *
 * «Следующая операция» = `index + 1`, она будет подсвечена коралловым
 * на heatmap, как «куда копится поток». Если bottleneck — последняя
 * операция, подсвечивается она сама (некуда передавать).
 */
export function detectAdminBottleneck(
  display: ShopfloorDisplayDto | null | undefined,
): {
  index: number;
  nextIndex: number;
  operationName: string;
  bufferDone: number;
} | null {
  if (!display) return null;
  const route = display.sewingRoute ?? [];
  if (route.length === 0) return null;
  let bestIdx = -1;
  let bestDone = 0;
  for (let i = 0; i < route.length; i++) {
    const done = sumRouteOperationField(route[i].rows, 'done');
    if (done > bestDone) {
      bestDone = done;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestDone < BOTTLENECK_BUFFER_THRESHOLD) return null;
  const nextIdx = Math.min(bestIdx + 1, route.length - 1);
  return {
    index: bestIdx,
    nextIndex: nextIdx,
    operationName: route[bestIdx].operationName,
    bufferDone: bestDone,
  };
}

/**
 * KPI-блок «Сегодня в производстве» для `/admin`. Учитываем, что
 * любой из источников может оказаться `null` (сетевой ретрай упал
 * или backend временно лежит) — в этом случае показываем «—»
 * вместо нуля, чтобы не вводить менеджера в заблуждение.
 */
export function buildAdminKpis(
  display: ShopfloorDisplayDto | null | undefined,
  masterCalls: ReadonlyArray<MasterCallDto> | null | undefined,
): AdminKpi[] {
  const kpi = display?.kpi ?? null;
  const bottleneck = detectAdminBottleneck(display ?? null);

  // Σ ✔ (буферы между операциями) — «Ждёт следующую операцию».
  // Сюда включаем sewing-буферы + qcDone + wtoDone, чтобы цифра
  // соответствовала вопросу менеджера «сколько готово к передаче».
  let waitingNext: number | null = null;
  if (display) {
    let acc = 0;
    for (const op of display.sewingRoute ?? []) {
      acc += sumRouteOperationField(op.rows, 'done');
    }
    acc += display.totals?.qtyQcDone ?? 0;
    acc += display.totals?.qtyWtoDone ?? 0;
    waitingNext = acc;
  }

  const openMasterCalls =
    masterCalls === null || masterCalls === undefined
      ? null
      : masterCalls.filter(
          (c) => (c.status as MasterCallStatus) === 'OPEN',
        ).length;

  const fmt = (n: number | null): string =>
    n === null ? '—' : n.toLocaleString('ru-RU');

  return [
    {
      id: 'producedToday',
      label: 'Выпуск сегодня',
      value: fmt(kpi ? kpi.producedToday : null),
      hint: 'PACKED за сегодня',
      tone: 'green',
      raw: kpi ? kpi.producedToday : null,
    },
    {
      id: 'inWork',
      label: 'В работе',
      value: fmt(kpi ? kpi.inWork : null),
      hint: 'Все живые паспорта',
      tone: 'orange',
      raw: kpi ? kpi.inWork : null,
    },
    {
      id: 'waitingNext',
      label: 'Ждут следующей операции',
      value: fmt(waitingNext),
      hint: 'Σ ✔ buffer + ОТК/ВТО',
      tone: 'blue',
      raw: waitingNext,
    },
    {
      id: 'masterCalls',
      label: 'Вызовы мастера',
      value: fmt(openMasterCalls),
      hint: openMasterCalls === 0 ? 'Тихо в цеху' : 'Открытых сейчас',
      tone: openMasterCalls && openMasterCalls > 0 ? 'purple' : 'purple',
      raw: openMasterCalls,
    },
    {
      id: 'bottleneck',
      label: 'Узкое место',
      value: bottleneck ? bottleneck.operationName : 'Нет',
      hint: bottleneck
        ? `Буфер ${bottleneck.bufferDone.toLocaleString('ru-RU')} шт`
        : 'Поток без затыков',
      tone: bottleneck ? 'coral' : 'green',
      raw: bottleneck ? bottleneck.bufferDone : 0,
    },
  ];
}

/**
 * Строит линейку чипов heatmap'а в порядке прохождения изделия:
 * Крой → sewing-операции (по sortOrder) → ОТК → ВТО → Упаковка →
 * Готово.
 *
 * `bottleneck.nextIndex` подсвечивается коралловым (узкое место);
 * если `display` пуст — возвращаем пустой массив (UI просто не
 * рендерит блок).
 */
export function buildProductionHeatmap(
  display: ShopfloorDisplayDto | null | undefined,
): HeatmapCell[] {
  if (!display) return [];

  const totals = display.totals ?? null;
  const sewingRoute = display.sewingRoute ?? [];
  const bottleneck = detectAdminBottleneck(display);
  const bottleneckSewingNext =
    bottleneck && bottleneck.nextIndex !== bottleneck.index
      ? bottleneck.nextIndex
      : -1;

  const cells: HeatmapCell[] = [];

  const cutTotal = totals?.qtyCut ?? 0;
  cells.push({
    key: 'CUT',
    label: 'Крой',
    inProgress: 0,
    done: cutTotal,
    total: cutTotal,
    tone: pickHeatmapTone(cutTotal),
    isBottleneck: false,
  });

  // Sewing-операции из маршрута.
  sewingRoute.forEach((op, idx) => {
    const inProgress = sumRouteOperationField(op.rows, 'inProgress');
    const done = sumRouteOperationField(op.rows, 'done');
    const total = inProgress + done;
    const isThisBottleneck =
      bottleneck !== null && idx === bottleneck.index && bottleneck.bufferDone > 0;
    const isNextBottleneck = idx === bottleneckSewingNext && total === 0;
    cells.push({
      key: `SEW:${op.operationId}`,
      label: op.operationName,
      inProgress,
      done,
      total,
      tone: isThisBottleneck || isNextBottleneck ? 'coral' : pickHeatmapTone(total),
      isBottleneck: isThisBottleneck || isNextBottleneck,
    });
  });

  const qcInProgress = totals?.qtyQc ?? 0;
  const qcDone = totals?.qtyQcDone ?? 0;
  const qcTotal = qcInProgress + qcDone;
  cells.push({
    key: 'QC',
    label: 'ОТК',
    inProgress: qcInProgress,
    done: qcDone,
    total: qcTotal,
    tone: pickHeatmapTone(qcTotal),
    isBottleneck: false,
  });

  const wtoInProgress = totals?.qtyWto ?? 0;
  const wtoDone = totals?.qtyWtoDone ?? 0;
  const wtoTotal = wtoInProgress + wtoDone;
  cells.push({
    key: 'WTO',
    label: 'ВТО',
    inProgress: wtoInProgress,
    done: wtoDone,
    total: wtoTotal,
    tone: pickHeatmapTone(wtoTotal),
    isBottleneck: false,
  });

  const packing = totals?.qtyPacking ?? 0;
  cells.push({
    key: 'PACKING',
    label: 'Упаковка',
    inProgress: packing,
    done: 0,
    total: packing,
    tone: pickHeatmapTone(packing),
    isBottleneck: false,
  });

  const finished = totals?.qtyFinished ?? 0;
  cells.push({
    key: 'FINISHED',
    label: 'Готово',
    inProgress: 0,
    done: finished,
    total: finished,
    // Готово — это «вышло из цеха», его всегда подсвечиваем зелёным,
    // если есть хотя бы что-то (визуально радует и подчёркивает успех).
    tone: finished > 0 ? 'green' : 'muted',
    isBottleneck: false,
  });

  return cells;
}
