/**
 * Плановая (теоретическая) экономика операции для карточки
 * `/admin/operations/[id]`: сколько единиц сотрудник теоретически
 * выполнит за 8-часовую смену и сколько при этом заработает по
 * текущей сдельной ставке.
 *
 * Это **только справочный расчёт** для управленческого экрана:
 *   - не подменяет фактические начисления (`SalaryEntry`,
 *     `OperationEntry`, `EarningsService`);
 *   - не участвует в payroll, в себестоимости заказа и в маршруте;
 *   - предназначен для оценки «реалистична ли ставка/норма» на
 *     этапе настройки операции.
 *
 * Формула (см. `docs/operation-time-norms-recon.md §10`):
 *
 *   unitsPerDay      = WORKDAY_SECONDS / timeNormSec
 *   earningsPerDay   = unitsPerDay * rateRub
 *
 * Если норма времени не задана — выработка/заработок не считаются;
 * если не задана ставка (или операция SALARY_ONLY) — считаем только
 * выработку, заработок остаётся `null`.
 */

/**
 * 8-часовая рабочая смена в секундах. Жёстко зафиксированный
 * управленческий «расчётный день» — payroll и фактические смены
 * (`Shift`) тут не участвуют, поэтому не привязываемся к таблицам
 * рабочего времени.
 */
export const WORKDAY_SECONDS = 8 * 60 * 60;

export interface OperationDailyEconomicsInput {
  /** Сдельная ставка за единицу, ₽. `null`/`undefined` — ставка не задана. */
  rateRub: number | null | undefined;
  /** Норма времени, секунды. `null`/`undefined`/0 — норма не задана. */
  timeNormSec: number | null | undefined;
  /** Длительность «расчётной смены», секунды. По умолчанию `WORKDAY_SECONDS`. */
  workdaySeconds?: number;
}

export interface OperationDailyEconomics {
  /**
   * Теоретическая выработка за смену (штук). `null`, если норма
   * времени не задана. Не округляется — округление оставлено UI.
   */
  unitsPerDay: number | null;
  /**
   * Теоретический заработок за смену (₽). `null`, если ставка или
   * норма не заданы. Не округляется — округление оставлено UI.
   */
  earningsPerDayRub: number | null;
}

/**
 * Рассчитать плановые «выработка/заработок за смену».
 *
 * Контракт (специально консервативен — UI ничего не «дорисовывает»):
 *   - `timeNormSec ≤ 0` или `null` ⇒ оба значения `null`;
 *   - `rateRub` `null`/`< 0`/не число ⇒ только `earningsPerDayRub = null`,
 *     `unitsPerDay` остаётся (это полезно даже для SALARY_ONLY —
 *     помогает оценить пропускную способность операции);
 *   - результат не округляется — округление до штук/рублей делает
 *     `formatUnitsPerDay` / `formatEarningsPerDay` (или сам экран).
 */
export function calculateOperationDailyEconomics(
  input: OperationDailyEconomicsInput,
): OperationDailyEconomics {
  const workdaySeconds = input.workdaySeconds ?? WORKDAY_SECONDS;
  const timeNormSec = input.timeNormSec;
  if (
    timeNormSec == null ||
    !Number.isFinite(timeNormSec) ||
    timeNormSec <= 0
  ) {
    return { unitsPerDay: null, earningsPerDayRub: null };
  }
  const unitsPerDay = workdaySeconds / timeNormSec;
  const rateRub = input.rateRub;
  if (rateRub == null || !Number.isFinite(rateRub) || rateRub < 0) {
    return { unitsPerDay, earningsPerDayRub: null };
  }
  return { unitsPerDay, earningsPerDayRub: unitsPerDay * rateRub };
}

/**
 * Округлить выработку до целых штук в меньшую сторону. Управленческий
 * расчёт сознательно «обрезает» дробную часть: дробных штук не бывает,
 * а накручивать вверх — преувеличивать ожидания.
 */
export function formatUnitsPerDay(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.floor(value).toLocaleString('ru-RU');
}

/**
 * Округлить заработок до целых рублей и форматировать с пробельным
 * разделителем тысяч и символом «₽» (`5 184 ₽`).
 */
export function formatEarningsPerDay(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString('ru-RU')} \u20BD`;
}

// ---------------------------------------------------------------------------
// SALARY_ONLY: плановая окладная экономика
// ---------------------------------------------------------------------------
//
// Для окладных операций (`pricingMode = SALARY_ONLY`) заработок не
// сдельный. Помогаем менеджеру оценить стоимость единицы и плановую
// выработку через плановую стоимость смены — `salaryPlanRubPerShift`
// и `salaryPlanShiftSeconds`. Это та же формула, что использует
// `OrderOperationPlanService` для расчёта плановой себестоимости
// окладных операций в плане заказа.
//
// Это **только presentation** — payroll / SalaryEntry /
// OperationEntry / Employee.salaryPerShift не задействованы.

export interface SalaryPlanEconomicsInput {
  /** Плановая стоимость одной смены, ₽. `null`/`<=0` — ставка не задана. */
  salaryPlanRubPerShift: number | null | undefined;
  /** Длительность «расчётной смены», секунды. `null`/`<=0` ⇒ 28800. */
  salaryPlanShiftSeconds: number | null | undefined;
  /** Норма времени, секунды. `null`/`undefined`/0 — норма не задана. */
  timeNormSec: number | null | undefined;
}

export interface SalaryPlanEconomics {
  /** Плановая стоимость одного изделия, ₽. `null`, если ставка/норма не заданы. */
  costPerUnitRub: number | null;
  /** Плановая выработка за смену, штук. `null`, если норма не задана. */
  unitsPerShift: number | null;
  /** Полная стоимость смены, ₽ (= salaryPlanRubPerShift). `null`, если не задано. */
  totalShiftCostRub: number | null;
  /**
   * Эффективная длительность смены, использованная в расчёте
   * (`salaryPlanShiftSeconds` или 28800). Удобно для UI «8ч» / «7ч».
   */
  effectiveShiftSeconds: number;
}

/**
 * Рассчитать плановую окладную экономику операции.
 *
 * Контракт (специально консервативен — UI ничего не «дорисовывает»):
 *   - `salaryPlanRubPerShift ≤ 0` или `null` ⇒ `costPerUnitRub` и
 *     `totalShiftCostRub` оба `null`;
 *   - `timeNormSec ≤ 0` или `null` ⇒ `unitsPerShift` `null` и
 *     `costPerUnitRub` `null` (нет нормы — нечем считать);
 *   - `salaryPlanShiftSeconds` `null/0` ⇒ fallback на 28800
 *     (8 часов), как и в `OperationsService.resolveSalaryPlanCostPerSecond`.
 */
export function calculateSalaryPlanEconomics(
  input: SalaryPlanEconomicsInput,
): SalaryPlanEconomics {
  const shiftSec =
    input.salaryPlanShiftSeconds && input.salaryPlanShiftSeconds > 0
      ? input.salaryPlanShiftSeconds
      : WORKDAY_SECONDS;

  const rate = input.salaryPlanRubPerShift;
  const norm = input.timeNormSec;

  const totalShiftCostRub =
    rate != null && Number.isFinite(rate) && rate > 0 ? rate : null;
  const unitsPerShift =
    norm != null && Number.isFinite(norm) && norm > 0
      ? shiftSec / norm
      : null;
  const costPerUnitRub =
    totalShiftCostRub !== null && unitsPerShift !== null && unitsPerShift > 0
      ? totalShiftCostRub / unitsPerShift
      : null;

  return {
    costPerUnitRub,
    unitsPerShift,
    totalShiftCostRub,
    effectiveShiftSeconds: shiftSec,
  };
}

/**
 * Форматировать стоимость одного изделия (₽). Округление до 2 знаков
 * после запятой — стоимость ≪ 1₽ типична для секундных операций.
 */
export function formatCostPerUnit(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  // Если стоимость > 100₽ — округляем до целых, иначе до 2 знаков:
  // дробные копейки не имеют смысла для крупных стоимостей, но для
  // 0.13₽ / 0.04₽ — нужны.
  if (value >= 100) {
    return `${Math.round(value).toLocaleString('ru-RU')} \u20BD`;
  }
  return `${value.toFixed(2).replace('.', ',')} \u20BD`;
}

// ---------------------------------------------------------------------------
// BY_SIZE: группировка строк экономики (presentation helper)
// ---------------------------------------------------------------------------
//
// На карточке `/admin/operations/[id]` правая колонка тесная, а у
// `BY_SIZE`-операций часто все размеры имеют одинаковую ставку и норму
// времени — то есть таблица из 21 одинаковой строки только тратит
// место и не помещается в правую колонку. Эти helper-ы группируют
// строки экономики по одинаковым значениям (rate / timeNorm /
// unitsPerDay / earningsPerDayRub) и формируют человекочитаемое
// название группы размеров.
//
// Это **только presentation** — backend / DTO / payroll / расчёт
// `calculateOperationDailyEconomics` не меняются.

/** Одна строка экономики операции для конкретного размера. */
export interface OperationEconomicsSizeRow {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  /** Ставка за единицу, ₽; `null` — не задана. */
  rateRub: number | null;
  /** Норма времени, секунды; `null`/`0` — не задана. */
  timeNormSec: number | null;
  /** Плановая выработка за смену, штук; `null`, если норма не задана. */
  unitsPerDay: number | null;
  /** Плановый заработок за смену, ₽; `null`, если ставка/норма не заданы. */
  earningsPerDayRub: number | null;
}

/**
 * Группа размеров с одинаковой экономикой. Все размеры внутри группы
 * имеют один и тот же набор `(rateRub, timeNormSec, unitsPerDay,
 * earningsPerDayRub)`, поэтому в UI можно показать одну строку на всю
 * группу.
 */
export interface OperationEconomicsGroup {
  /** Размеры группы, отсортированы по `sizeSortOrder`. */
  sizes: OperationEconomicsSizeRow[];
  /** Короткая подпись («Все размеры», «XS, S, M», «104, 110 + ещё 12»). */
  sizeLabel: string;
  /** Полный список размеров через запятую — для атрибута `title`. */
  sizeTitle: string;
  rateRub: number | null;
  timeNormSec: number | null;
  unitsPerDay: number | null;
  earningsPerDayRub: number | null;
}

/**
 * Нормализовать число для ключа группировки. `null`, `undefined` и
 * нечисловые значения превращаются в строку `'null'`, чтобы все
 * «незаданные» значения попадали в одну группу.
 */
function normalizeNumberKey(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'null';
  return String(value);
}

/**
 * Сгруппировать строки экономики по одинаковым ставке / норме /
 * выработке / заработку. Порядок групп — по `sizeSortOrder` первого
 * размера; внутри группы — по `sizeSortOrder`.
 *
 * Расчёт значений (`unitsPerDay` / `earningsPerDayRub`) НЕ выполняется
 * здесь: helper принимает уже готовые строки. Это позволяет легко
 * fixture-тестировать его в отрыве от формулы и не дублирует логику
 * `calculateOperationDailyEconomics`.
 */
export function groupOperationEconomicsRows(
  rows: OperationEconomicsSizeRow[],
): OperationEconomicsGroup[] {
  const buckets = new Map<string, OperationEconomicsSizeRow[]>();
  for (const row of rows) {
    const key = [
      normalizeNumberKey(row.rateRub),
      normalizeNumberKey(row.timeNormSec),
      normalizeNumberKey(row.unitsPerDay),
      normalizeNumberKey(row.earningsPerDayRub),
    ].join('|');
    const list = buckets.get(key);
    if (list) {
      list.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  const result: OperationEconomicsGroup[] = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
    const first = list[0];
    if (!first) continue;
    result.push({
      sizes: list,
      sizeLabel: formatSizeGroupLabel(list, rows.length),
      sizeTitle: list.map((s) => s.sizeCode).join(', '),
      rateRub: first.rateRub,
      timeNormSec: first.timeNormSec,
      unitsPerDay: first.unitsPerDay,
      earningsPerDayRub: first.earningsPerDayRub,
    });
  }
  result.sort((a, b) => {
    const aFirst = a.sizes[0]?.sizeSortOrder ?? 0;
    const bFirst = b.sizes[0]?.sizeSortOrder ?? 0;
    return aFirst - bFirst;
  });
  return result;
}

/**
 * Сформировать короткую подпись для группы размеров.
 *
 * Правила:
 *   - если в группе все размеры (`groupSizes.length === totalSizes`)
 *     ⇒ `«Все размеры»`;
 *   - если ≤ 6 размеров ⇒ перечислить коды через запятую
 *     (`«XS, S, M, L»`);
 *   - иначе ⇒ показать первые 5 кодов и «+ ещё N»
 *     (`«104, 110, 116, 122, 128 + ещё 12»`); полный список
 *     рекомендуется положить в `title`.
 */
export function formatSizeGroupLabel(
  groupSizes: ReadonlyArray<{ sizeCode: string }>,
  totalSizes: number,
): string {
  if (groupSizes.length === 0) return '';
  if (totalSizes > 0 && groupSizes.length === totalSizes) {
    return 'Все размеры';
  }
  if (groupSizes.length <= 6) {
    return groupSizes.map((s) => s.sizeCode).join(', ');
  }
  const head = groupSizes
    .slice(0, 5)
    .map((s) => s.sizeCode)
    .join(', ');
  const rest = groupSizes.length - 5;
  return `${head} + ещё ${rest}`;
}
