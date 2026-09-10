/**
 * `buildOrderOperationRows` — собирает плоский список строк
 * `OrderOperationTableRow` для unified-таблицы операций в карточке
 * заказа `/admin/orders/[id]` (вкладка «Операции»).
 *
 * Это **чисто web-side агрегатор**: backend / Prisma / OperationPlan
 * formulas / ProductionBalanceService / payroll / Passport /
 * OperationEntry НЕ меняются. Помощник переиспользует уже
 * существующие DTO:
 *
 *   - `OrderRouteStepDto`            — snapshot шагов маршрута заказа;
 *   - `OperationDetailDto`           — pricingMode / timeNormMode + размеры;
 *   - `OrderItemDto`                 — qtyPlan по размерам;
 *   - `PassportListItemDto`          — `currentRouteStepIndex`/`status`,
 *                                      чтобы посчитать ожидает/в работе/
 *                                      выполнено;
 *   - `OrderProductionBalanceLineDto` — workSec / avgSecPerUnit / warnings,
 *                                      посчитанные backend-ом без
 *                                      изменения формул.
 *
 * Никаких новых таблиц / enum-ов / статусов в БД не вводим: статусы
 * Ожидает / В работе / Выполнено вычисляются «на лету» по passports
 * (см. ТЗ §3 «Статусы операций») и при недостатке данных деградируют
 * к «Ожидает» с warning-плашкой в комментарии.
 *
 * СТОРОННИЕ УСЛУГИ (решение владельца 10.09.2026). Шаг маршрута можно
 * пометить «делаем на стороне» (`OrderRouteStep.outsourced`) целиком или
 * на часть тиража (`sizeOverrides[].outsourcedQty`): по отданному объёму
 * своя расценка в план не идёт, вместо неё считается цена размещения
 * (`OrderRouteStep.outsourcePriceRub` за ОДНО изделие). Деньги строки =
 * своя расценка на остаток + размещение на отданный объём, то есть ровно
 * то, что кладёт в `Order.operationCostPlanRub` backend
 * (`OrderOperationPlanService.computeTotals`). Совпадение обязано быть до
 * копейки: «Сводно по заказу» сравнивает сумму строк со снимком заказа и
 * поднимает «план операций разошёлся» на любом расхождении ≥ 1 копейки
 * (`build-order-summary-rows.ts::computeOrderSummaryTotals`).
 * Метка — только про деньги: плановое время, статусы, паспорта и ЗП её
 * не читают.
 */
import type { OperationDetailDto } from '@sewing/shared/operations';
import type { OrderItemDto, OrderRouteStepDto } from '@sewing/shared/orders';
import type { OrderProductionBalanceLineDto } from '@sewing/shared/order-production-balance';
import type { PassportListItemDto } from '@sewing/shared/passports';

/** Тон UI-статуса строки таблицы операций. */
export type OrderOperationStatusTone =
  | 'neutral'
  | 'warning'
  | 'success'
  | 'info';

/** Лейбл вычисляемого статуса операции. */
export type OrderOperationStatusLabel =
  | 'Ожидает'
  | 'В работе'
  | 'Выполнено';

/**
 * Денормализованная строка таблицы «Операции» в карточке заказа.
 *
 * Все суммы/времена выражены в стандартных единицах:
 *   - `plannedQty`/`waitingQty`/`inProgressQty`/`completedQty` — штуки,
 *   - `totalTimeSec` — секунды,
 *   - `lineTotalRub` — рубли (число), null если посчитать невозможно.
 */
export interface OrderOperationTableRow {
  /** `OrderRouteStep.id` — уникальный ключ строки. */
  id: string;
  /** Индекс шага маршрута (0-based). */
  routeStepIndex: number;
  /** `№` колонки = `routeStepIndex + 1`. */
  rowNumber: number;
  /** `OrderRouteStep.operationId`. */
  operationId: string;
  /** Имя операции — единственное поле, которое мы показываем без
   * категории (см. ТЗ §1 «Убрать колонку Категория»). */
  operationName: string;
  /** Код операции — для tooltip / data-attribute. Категорию не
   * показываем (ТЗ §1). */
  operationCode: string;

  // ----- Status (computed, см. ТЗ §3) -----------------------------------
  statusLabel: OrderOperationStatusLabel;
  statusTone: OrderOperationStatusTone;

  // ----- Quantities -----------------------------------------------------
  plannedQty: number;
  waitingQty: number;
  inProgressQty: number;
  completedQty: number;

  // ----- Pricing & time-norm display ------------------------------------
  /** Текст для колонки «Норма» (`'1 мин 20 сек'` / `'по размерам'`
   *  / `'—'`). */
  normLabel: string;
  /** Текст для колонки «Цена» (`'25 ₽/шт'` / `'окладная'` /
   *  `'по размерам'` / `'—'`). */
  priceLabel: string;
  /** Чтобы UI мог проставить data-attribute / tooltip. */
  pricingMode: 'FIXED' | 'BY_SIZE' | 'SALARY_ONLY' | null;
  timeNormMode: 'FIXED' | 'BY_SIZE' | null;

  // ----- Time / cost (computed, см. ТЗ §6/§7) ---------------------------
  /** Σ `qtyBySize × timeSec(op,size)` (целое количество секунд). `null`,
   *  если ни для одного размера нет нормы — в комментарии добавим
   *  warning «Нет нормы времени». */
  totalTimeSec: number | null;
  /** Плановая стоимость операции на тираж в рублях: своя расценка на
   *  остаток ПЛЮС стороннее размещение на отданный объём (то же, что
   *  кладёт в план backend). `null`, если посчитать невозможно (нет
   *  ставки / нет нормы для SALARY_ONLY). */
  lineTotalRub: number | null;
  /** Подпись стоимости в случае SALARY_ONLY без shift-rate (UI рисует
   *  «окладная» вместо суммы). */
  costFallbackLabel: string | null;

  // ----- Сторонние услуги (метка «делаем на стороне») -------------------
  /** Шаг помечен `OrderRouteStep.outsourced`: операцию целиком или
   *  частью тиража выполняет подрядчик. UI рисует нейтральный бейдж
   *  рядом с названием операции. */
  isOutsourced: boolean;
  /** Сколько штук планового тиража операции отдано подрядчику. `0` —
   *  метки нет либо по размерам не набралось ни одной штуки. */
  outsourcedQty: number;
  /** Цена размещения за ОДНО изделие (₽) или `null` — цена не задана
   *  (в план идёт 0 + warning, молчаливый ноль читался бы как
   *  «подряд бесплатный»). */
  outsourcePriceRub: number | null;
  /** Стоимость размещения на тираж = цена × отданный объём (₽). `null`
   *  — операция не на стороне; `0` — на стороне, но цена не задана.
   *  Это РАСШИФРОВКА внутри `lineTotalRub`, а не добавка к нему:
   *  складывать нельзя (см. `Order.operationOutsourceCostPlanRub`). */
  outsourceCostRub: number | null;

  // ----- Comment / warnings ---------------------------------------------
  /** Свободный комментарий (например, «План операций неполный»). */
  commentText: string | null;
  /** Warnings-блок: «Нет ставки», «Нет нормы времени», «Недостаточно
   *  данных для статуса» и т.п. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

function formatRub(value: number): string {
  return `${RUB_FORMATTER.format(value)} ₽/шт`;
}

function uniqueRates(rates: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const r of rates) {
    if (!Number.isFinite(r)) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function formatRateRange(rates: number[]): string {
  const distinct = uniqueRates(rates);
  if (distinct.length === 0) return '—';
  if (distinct.length === 1) return formatRub(distinct[0]);
  const min = Math.min(...distinct);
  const max = Math.max(...distinct);
  if (min === max) return formatRub(min);
  return `${RUB_FORMATTER.format(min)}–${RUB_FORMATTER.format(max)} ₽/шт`;
}

function formatTimeRange(seconds: number[]): string {
  const distinct = uniqueRates(seconds);
  if (distinct.length === 0) return '—';
  if (distinct.length === 1) return formatSecondsHuman(distinct[0]);
  const min = Math.min(...distinct);
  const max = Math.max(...distinct);
  if (min === max) return formatSecondsHuman(min);
  return `${formatSecondsHuman(min)}–${formatSecondsHuman(max)}`;
}

/**
 * Локальное короткое форматирование длительности (для значения
 * нормы в одной ячейке таблицы). Полная версия живёт в
 * `apps/web/lib/operations-time-norm.ts::formatDuration` и
 * используется UI-компонентом для агрегатных времён операции.
 */
function formatSecondsHuman(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '—';
  const safe = Math.max(0, Math.floor(total));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (seconds > 0) parts.push(`${seconds} сек`);
  return parts.length > 0 ? parts.join(' ') : '0 сек';
}

// ---------------------------------------------------------------------------
// Эффективные значения с учётом per-order переопределений
// (`OrderRouteStep.rateOverride` / `timeNormSecOverride` /
// `OrderRouteStepSizeOverride`). Переопределение заказа вытесняет дефолт
// операции — read-only дисплей должен совпадать с тем, что считает
// backend (`resolveRate` / `OrderOperationPlanService`). См. ТЗ «суммы
// внутри заказа действуют только внутри заказа».
// ---------------------------------------------------------------------------

function effFixedRate(
  op: OperationDetailDto,
  step: OrderRouteStepDto,
): number | null {
  if (step.rateOverride != null && Number.isFinite(step.rateOverride)) {
    return step.rateOverride;
  }
  return op.fixedRate != null && Number.isFinite(Number(op.fixedRate))
    ? Number(op.fixedRate)
    : null;
}

function effSizeRate(
  op: OperationDetailDto,
  step: OrderRouteStepDto,
  sizeId: string,
): number | null {
  const ov = step.sizeOverrides.find((o) => o.sizeId === sizeId);
  if (ov?.rate != null && Number.isFinite(ov.rate)) return ov.rate;
  const row = op.ratesBySize.find((r) => r.sizeId === sizeId);
  return row && Number.isFinite(Number(row.rate)) ? Number(row.rate) : null;
}

function effFixedSec(
  op: OperationDetailDto,
  step: OrderRouteStepDto,
): number | null {
  if (step.timeNormSecOverride != null && Number.isFinite(step.timeNormSecOverride)) {
    return step.timeNormSecOverride;
  }
  return op.timeNormSec != null && Number.isFinite(op.timeNormSec)
    ? op.timeNormSec
    : null;
}

function effSizeSec(
  op: OperationDetailDto,
  step: OrderRouteStepDto,
  sizeId: string,
): number | null {
  const ov = step.sizeOverrides.find((o) => o.sizeId === sizeId);
  if (ov?.seconds != null && Number.isFinite(ov.seconds)) return ov.seconds;
  const row = op.timeNormsBySize.find((t) => t.sizeId === sizeId);
  return row && Number.isFinite(Number(row.seconds))
    ? Number(row.seconds)
    : null;
}

// ---------------------------------------------------------------------------
// Сторонние услуги: раскладка планового тиража операции на «своё» и
// «отданное подрядчику»
// ---------------------------------------------------------------------------

/**
 * Раскладка объёма шага маршрута между цехом и подрядчиком —
 * единственный источник «сколько штук чьи» для цены, стоимости и
 * warnings строки.
 */
interface OutsourceSplit {
  /** Шаг помечен «делаем на стороне». `false` ⇒ ниже всё считается как
   *  до появления метки (остаток = весь тираж, размещение = 0). */
  active: boolean;
  /** `sizeId → сколько штук цех делает сам` (тираж минус отданное). */
  ownBySize: Map<string, number>;
  /** Свой объём для режима FIXED — тираж заказа минус отданное. Держим
   *  отдельно от `ownBySize`, потому что FIXED-ветка исторически считает
   *  по `qtyPlanTotal` заказа, а не по сумме поразмерных строк. */
  ownFixedQty: number;
  /** Σ отданного подрядчику, штук. */
  outQtyTotal: number;
  /** Весь плановый объём операции на стороне — своя ставка не нужна
   *  вовсе, и требовать её warning-ом бессмысленно. */
  fullyOutsourced: boolean;
  /** Цена размещения за изделие (₽) или `null`. */
  priceRub: number | null;
  /** Σ размещения = цена × отданный объём; `0`, если цена не задана. */
  costRub: number;
  warnings: string[];
}

/**
 * ПРАВИЛО РАСЧЁТА подряда (одно на цех, backend и web — расходиться
 * нельзя, см. шапку файла):
 *
 *   - метки нет → `active = false`, дальше всё как раньше;
 *   - метка есть, поразмерных объёмов нет → на стороне ВЕСЬ тираж
 *     операции (владелец пометил операцию целиком);
 *   - метка есть и объёмы расписаны → на стороне ровно эти штуки,
 *     обрезанные планом по размеру; размер без строки — целиком свой
 *     (`outsourcedQty = null` значит «не расписан», а не «всё»).
 *
 * Отданный объём считаем по агрегату `sizeId → qtyPlan`: backend
 * раздаёт остаток жадно по строкам плана, но сумма по размеру у обоих
 * одна и та же — `min(outsourcedQty, план по размеру)`.
 */
function resolveOutsourceSplit(
  step: OrderRouteStepDto,
  itemsBySize: Map<string, number>,
  totalQty: number,
): OutsourceSplit {
  const ownBySize = new Map(itemsBySize);
  if (step.outsourced !== true) {
    return {
      active: false,
      ownBySize,
      ownFixedQty: totalQty,
      outQtyTotal: 0,
      fullyOutsourced: false,
      priceRub: null,
      costRub: 0,
      warnings: [],
    };
  }

  // Значимы только заданные строки: `null` — «размер не расписан»,
  // а `0` — осознанное «этот размер делаем сами».
  const outBySize = new Map<string, number>();
  for (const ov of step.sizeOverrides) {
    if (ov.outsourcedQty == null || !Number.isFinite(ov.outsourcedQty)) continue;
    outBySize.set(ov.sizeId, Math.max(0, ov.outsourcedQty));
  }

  let outQtyTotal = 0;
  for (const [sizeId, qty] of itemsBySize.entries()) {
    if (qty <= 0) continue;
    const requested = outBySize.size === 0 ? qty : (outBySize.get(sizeId) ?? 0);
    // Больше плана по размеру отдать нельзя — иначе «своя» часть ушла бы
    // в минус и план операций стал бы меньше реального.
    const out = Math.min(Math.max(0, requested), qty);
    if (out <= 0) continue;
    outQtyTotal += out;
    ownBySize.set(sizeId, qty - out);
  }

  let ownQtyTotal = 0;
  for (const qty of ownBySize.values()) {
    if (qty > 0) ownQtyTotal += qty;
  }
  const fullyOutsourced = outQtyTotal > 0 && ownQtyTotal <= 0;

  const priceRub =
    step.outsourcePriceRub != null &&
    Number.isFinite(step.outsourcePriceRub) &&
    step.outsourcePriceRub >= 0
      ? step.outsourcePriceRub
      : null;

  const warnings: string[] = [];
  if (outQtyTotal > 0 && priceRub == null) {
    warnings.push(
      'Не задана цена стороннего размещения — размещение посчитано как 0',
    );
  }

  return {
    active: true,
    ownBySize,
    // При полном подряде своего объёма нет по определению, даже если
    // `qtyPlanTotal` заказа шире суммы поразмерных строк.
    ownFixedQty: fullyOutsourced ? 0 : Math.max(0, totalQty - outQtyTotal),
    outQtyTotal,
    fullyOutsourced,
    priceRub,
    costRub: priceRub != null ? priceRub * outQtyTotal : 0,
    warnings,
  };
}

/**
 * Σ времени по произвольным весам (`sizeId → штук`) — зеркало
 * `resolveNormLabel` по правилам выбора нормы, но с другим множителем.
 * Нужно ровно одному потребителю: окладной части плана, которую подряд
 * ужимает до остатка (`ownBySize`). Само плановое время строки метка не
 * трогает — решение владельца «метка только про деньги».
 */
function sumTimeSecForQty(
  op: OperationDetailDto,
  step: OrderRouteStepDto,
  qtyBySize: Map<string, number>,
): number | null {
  if (op.timeNormMode === 'FIXED') {
    const sec = effFixedSec(op, step);
    if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
    let qty = 0;
    for (const q of qtyBySize.values()) {
      if (q > 0) qty += q;
    }
    return qty > 0 ? qty * sec : null;
  }
  if (op.timeNormMode === 'BY_SIZE') {
    let total = 0;
    for (const [sizeId, qty] of qtyBySize.entries()) {
      if (qty <= 0) continue;
      const sec = effSizeSec(op, step, sizeId);
      if (sec == null || !Number.isFinite(sec) || sec <= 0) continue;
      total += qty * sec;
    }
    return total > 0 ? total : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pricing label resolver
// ---------------------------------------------------------------------------

interface PriceResolution {
  label: string;
  warnings: string[];
}

/**
 * Текст колонки «Цена». При подряде показываем обе цены, потому что за
 * тираж платятся обе: своя расценка — за остаток, цена размещения — за
 * отданный объём («25 ₽/шт · сторона 180 ₽/шт»). Если на стороне весь
 * объём, своя расценка не участвует в плане — не показываем её и не
 * требуем warning-ом.
 */
function resolvePriceLabel(
  op: OperationDetailDto | null,
  uniqueOrderSizeIds: string[],
  step: OrderRouteStepDto,
  split: OutsourceSplit,
): PriceResolution {
  const own = resolveOwnPriceLabel(op, uniqueOrderSizeIds, step, split);
  if (!split.active || split.outQtyTotal <= 0) return own;

  const outLabel = split.priceRub != null ? formatRub(split.priceRub) : '—';
  const label =
    split.fullyOutsourced || own.label === '—'
      ? `сторона ${outLabel}`
      : `${own.label} · сторона ${outLabel}`;
  return { label, warnings: own.warnings };
}

function resolveOwnPriceLabel(
  op: OperationDetailDto | null,
  uniqueOrderSizeIds: string[],
  step: OrderRouteStepDto,
  split: OutsourceSplit,
): PriceResolution {
  const warnings: string[] = [];
  if (!op) {
    warnings.push('Нет данных об операции');
    return { label: '—', warnings };
  }
  /** Своя ставка при полном подряде в план не входит — её отсутствие не
   *  повод шуметь (тот же гейт стоит в backend-warnings плана). */
  const pushNoRate = () => {
    if (!split.fullyOutsourced) warnings.push('Нет ставки');
  };
  // Эффективный способ оплаты: переопределение заказа (оклад ⇄ сделка)
  // вытесняет дефолт операции (см. `OperationsService.resolveRate`).
  const mode = step.pricingModeOverride ?? op.pricingMode;
  if (mode === 'SALARY_ONLY') {
    return { label: 'окладная', warnings };
  }
  if (mode === 'FIXED') {
    const rate = effFixedRate(op, step);
    if (rate == null) {
      pushNoRate();
      return { label: '—', warnings };
    }
    return { label: formatRub(rate), warnings };
  }
  if (mode === 'BY_SIZE') {
    // ТЗ §4: если в заказе один размер — показать ставку для этого
    // размера; иначе диапазон / «по размерам». Учитываем поразмерные
    // переопределения заказа.
    const ratesForOrder: number[] = [];
    for (const sid of uniqueOrderSizeIds) {
      const r = effSizeRate(op, step, sid);
      if (r != null) ratesForOrder.push(r);
    }
    if (ratesForOrder.length === 0) {
      pushNoRate();
      return { label: '—', warnings };
    }
    if (uniqueOrderSizeIds.length === 1) {
      return { label: formatRub(ratesForOrder[0]), warnings };
    }
    return { label: formatRateRange(ratesForOrder), warnings };
  }
  return { label: '—', warnings };
}

// ---------------------------------------------------------------------------
// Time-norm label resolver
// ---------------------------------------------------------------------------

interface NormResolution {
  label: string;
  warnings: string[];
  /** Σ qtyBySize × timeSec — нужно для колонки «Время» / «Стоимость». */
  totalTimeSec: number | null;
}

function resolveNormLabel(
  op: OperationDetailDto | null,
  itemsBySize: Map<string, number>,
  uniqueOrderSizeIds: string[],
  step: OrderRouteStepDto,
): NormResolution {
  const warnings: string[] = [];
  if (!op) {
    warnings.push('Нет нормы времени');
    return { label: '—', warnings, totalTimeSec: null };
  }
  const mode = op.timeNormMode;
  if (mode === 'FIXED') {
    const sec = effFixedSec(op, step);
    if (sec == null || !Number.isFinite(sec) || sec <= 0) {
      warnings.push('Нет нормы времени');
      return { label: '—', warnings, totalTimeSec: null };
    }
    let totalQty = 0;
    for (const q of itemsBySize.values()) totalQty += q;
    return {
      label: formatSecondsHuman(sec),
      warnings,
      totalTimeSec: totalQty > 0 ? totalQty * sec : null,
    };
  }
  if (mode === 'BY_SIZE') {
    const secsForOrder: number[] = [];
    let totalSec = 0;
    let missing = 0;
    for (const sid of uniqueOrderSizeIds) {
      const qty = itemsBySize.get(sid) ?? 0;
      if (qty <= 0) continue;
      const sec = effSizeSec(op, step, sid);
      if (sec == null || !Number.isFinite(sec) || sec <= 0) {
        missing += 1;
        continue;
      }
      secsForOrder.push(sec);
      totalSec += qty * sec;
    }
    if (secsForOrder.length === 0) {
      warnings.push('Нет нормы времени');
      return { label: '—', warnings, totalTimeSec: null };
    }
    if (missing > 0) {
      warnings.push('Нет нормы времени для части размеров');
    }
    if (uniqueOrderSizeIds.length === 1) {
      return {
        label: formatSecondsHuman(secsForOrder[0]),
        warnings,
        totalTimeSec: totalSec > 0 ? totalSec : null,
      };
    }
    return {
      label: formatTimeRange(secsForOrder),
      warnings,
      totalTimeSec: totalSec > 0 ? totalSec : null,
    };
  }
  warnings.push('Нет нормы времени');
  return { label: '—', warnings, totalTimeSec: null };
}

// ---------------------------------------------------------------------------
// Cost resolver
// ---------------------------------------------------------------------------

interface CostResolution {
  lineTotalRub: number | null;
  fallbackLabel: string | null;
  warnings: string[];
}

/** Своя (цеховая) часть плана операции — без размещения. */
interface OwnCostResolution {
  rub: number | null;
  fallbackLabel: string | null;
  /**
   * `true` ⇔ backend по своей части этой операции тоже добавит в план
   * ровно 0: нет ставки, нет нормы или весь объём ушёл подрядчику.
   * Отличать это от «web не смог посчитать» нужно ради подряда: у
   * операции на стороне строка обязана показать `0 + размещение`, а не
   * пустоту — иначе сумма строк разойдётся со снимком
   * `Order.operationCostPlanRub` ровно на размещение.
   */
  matchesZeroPlan: boolean;
}

/**
 * Стоимость строки = своя расценка на остаток + цена размещения на
 * отданный подрядчику объём (см. ПРАВИЛО РАСЧЁТА в шапке файла).
 * `Order.operationCostPlanRub` — ПОЛНЫЙ план операций, поэтому
 * размещение сидит внутри `lineTotalRub`, а не рядом с ним.
 */
function resolveCost(
  op: OperationDetailDto | null,
  totalTimeSec: number | null,
  step: OrderRouteStepDto,
  split: OutsourceSplit,
): CostResolution {
  const warnings: string[] = [];
  if (!op) {
    warnings.push('Нет данных об операции');
    return { lineTotalRub: null, fallbackLabel: null, warnings };
  }

  const own = resolveOwnCost(op, totalTimeSec, step, split);
  if (!split.active) {
    // Подряда нет — отдаём ровно то, что отдавали до появления метки.
    return {
      lineTotalRub: own.rub,
      fallbackLabel: own.fallbackLabel,
      warnings,
    };
  }
  if (own.rub != null) {
    return {
      lineTotalRub: own.rub + split.costRub,
      fallbackLabel: null,
      warnings,
    };
  }
  if (own.matchesZeroPlan) {
    // Своей части в плане нет (весь объём на стороне / нет ставки) —
    // строка равна размещению. Ноль без цены размещения тоже показываем:
    // он честно повторяет план и объяснён warning-ом.
    return { lineTotalRub: split.costRub, fallbackLabel: null, warnings };
  }
  // Остался единственный случай — окладная операция, чью ставку web не
  // воспроизводит (плановая ставка задана, а длительность смены нет).
  // Сумму не выдумываем: пусть строка честно скажет «окладная», а
  // размещение видно в расшифровке итога.
  return { lineTotalRub: null, fallbackLabel: own.fallbackLabel, warnings };
}

function resolveOwnCost(
  op: OperationDetailDto,
  totalTimeSec: number | null,
  step: OrderRouteStepDto,
  split: OutsourceSplit,
): OwnCostResolution {
  // Эффективный способ оплаты с учётом переопределения заказа.
  const mode = step.pricingModeOverride ?? op.pricingMode;
  if (mode === 'FIXED') {
    const rate = effFixedRate(op, step);
    if (rate == null) {
      return { rub: null, fallbackLabel: null, matchesZeroPlan: true };
    }
    // Своя расценка — только на остаток тиража (без подряда остаток =
    // весь тираж заказа, как и было).
    if (split.ownFixedQty <= 0) {
      return { rub: null, fallbackLabel: null, matchesZeroPlan: true };
    }
    return {
      rub: rate * split.ownFixedQty,
      fallbackLabel: null,
      matchesZeroPlan: false,
    };
  }
  if (mode === 'BY_SIZE') {
    let total = 0;
    let priced = 0;
    for (const [sid, qty] of split.ownBySize.entries()) {
      if (qty <= 0) continue;
      const r = effSizeRate(op, step, sid);
      if (r == null) continue;
      total += r * qty;
      priced += 1;
    }
    if (priced === 0) {
      // Ни одной оплачиваемой пары (размер × остаток): backend по таким
      // парам тоже добавляет 0 (размер без ставки он пропускает).
      return { rub: null, fallbackLabel: null, matchesZeroPlan: true };
    }
    return { rub: total, fallbackLabel: null, matchesZeroPlan: false };
  }
  if (mode === 'SALARY_ONLY') {
    // Если у операции заданы salaryPlanRubPerShift + shiftSeconds +
    // нормы времени — считаем как (timeSec × ставка_за_секунду).
    // Подряд ужимает время до остатка: время СТРОКИ метка не трогает
    // (оно за весь тираж), а окладные деньги — да.
    const ratePerShift = op.salaryPlanRubPerShift;
    const shiftSec = op.salaryPlanShiftSeconds ?? 0;
    const ownTimeSec = split.active
      ? sumTimeSecForQty(op, step, split.ownBySize)
      : totalTimeSec;
    const hasPlanRate = ratePerShift != null && Number.isFinite(ratePerShift);
    if (
      hasPlanRate &&
      shiftSec > 0 &&
      ownTimeSec != null &&
      ownTimeSec > 0
    ) {
      const ratePerSec = Number(ratePerShift) / shiftSec;
      return {
        rub: ratePerSec * ownTimeSec,
        fallbackLabel: null,
        matchesZeroPlan: false,
      };
    }
    // Иначе UI рисует «окладная» — точная оценка считается на
    // backend в сводном `Order.operationCostPlanRub`, мы не дублируем
    // эту формулу в web. Но если считать было НЕЧЕГО (нет плановой
    // ставки / нет времени по остатку), backend тоже запишет 0 — и для
    // операции на стороне это позволяет показать сумму размещения.
    return {
      rub: null,
      fallbackLabel: 'окладная',
      matchesZeroPlan: !hasPlanRate || ownTimeSec == null || ownTimeSec <= 0,
    };
  }
  return { rub: null, fallbackLabel: null, matchesZeroPlan: true };
}

// ---------------------------------------------------------------------------
// Status resolver — Ожидает / В работе / Выполнено (см. ТЗ §3)
// ---------------------------------------------------------------------------

interface StatusBuckets {
  waiting: number;
  inProgress: number;
  completed: number;
}

/**
 * Делит планы тиража по операциям маршрута на три счётчика на
 * основании паспортов. Источник «факта»:
 *   - `passport.qtyCut` — сколько штук уплыло в этот паспорт;
 *   - `passport.currentRouteStepIndex` — индекс активного шага
 *     маршрута (0-based); `null` означает «ещё не двинулся».
 *   - `passport.status === 'PACKED'` — паспорт прошёл всю цепочку.
 *
 * Правила (минимум, который не ломает SALARY_ONLY и не требует
 * `OperationEntry`):
 *   - Выполнено: `status === 'PACKED'` ИЛИ
 *                `currentRouteStepIndex > stepIndex`.
 *   - В работе:  `currentRouteStepIndex === stepIndex` (паспорт стоит
 *                на этой операции).
 *   - Ожидает:   всё остальное (операция ещё впереди или паспорт
 *                ни разу не сканировался).
 *
 * Если данных недостаточно (например, у заказа нет ни одного
 * паспорта), статус строки = «Ожидает», и в комментарии добавляется
 * warning «Недостаточно данных» (это решается в `buildOrderOperationRows`).
 */
function resolvePassportBuckets(
  stepIndex: number,
  passports: PassportListItemDto[],
): StatusBuckets {
  let waiting = 0;
  let inProgress = 0;
  let completed = 0;
  for (const p of passports) {
    const qty = Number.isFinite(p.qtyCut) ? Math.max(0, p.qtyCut) : 0;
    if (qty <= 0) continue;
    if (p.status === 'PACKED') {
      completed += qty;
      continue;
    }
    const idx = p.currentRouteStepIndex;
    if (idx == null) {
      waiting += qty;
      continue;
    }
    if (idx > stepIndex) {
      completed += qty;
    } else if (idx === stepIndex) {
      inProgress += qty;
    } else {
      waiting += qty;
    }
  }
  return { waiting, inProgress, completed };
}

function deriveStatus(
  plannedQty: number,
  buckets: StatusBuckets,
): { label: OrderOperationStatusLabel; tone: OrderOperationStatusTone } {
  // ТЗ §3:
  //   Выполнено: completedQty >= plannedQty (и planned > 0).
  //   В работе: inProgress > 0 ИЛИ (completed > 0 && completed < planned).
  //   Ожидает:  всё остальное.
  if (plannedQty > 0 && buckets.completed >= plannedQty) {
    return { label: 'Выполнено', tone: 'success' };
  }
  if (
    buckets.inProgress > 0 ||
    (buckets.completed > 0 && buckets.completed < plannedQty)
  ) {
    return { label: 'В работе', tone: 'info' };
  }
  return { label: 'Ожидает', tone: 'neutral' };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

interface BuildRowsInput {
  routeSteps: OrderRouteStepDto[];
  items: OrderItemDto[];
  qtyPlanTotal: number;
  passports: PassportListItemDto[];
  /** Map по `Operation.id` → `OperationDetailDto`. Если detail не
   *  загружен (например, операция удалена / API упал) — берём `null`,
   *  и UI покажет «—» с warning. */
  operationsById: Map<string, OperationDetailDto>;
  /** Опциональная карта `operationId → OrderProductionBalanceLineDto`,
   *  если backend смог посчитать `workSec` / warnings. На MVP мы
   *  предпочитаем web-side расчёт, но balance.line.warnings слепо
   *  переносим в комментарий, чтобы менеджер видел ту же диагностику,
   *  что и в legacy «Производственная цепочка». */
  balanceByOperationId?: Map<string, OrderProductionBalanceLineDto>;
}

export function buildOrderOperationRows(
  input: BuildRowsInput,
): OrderOperationTableRow[] {
  const {
    routeSteps,
    items,
    qtyPlanTotal,
    passports,
    operationsById,
    balanceByOperationId,
  } = input;

  // Карта `sizeId → qtyPlan` для O(1) лукапа в pricing/норме
  // времени.
  const itemsBySize = new Map<string, number>();
  for (const it of items) {
    if (Number.isFinite(it.qtyPlan) && it.qtyPlan > 0) {
      itemsBySize.set(
        it.sizeId,
        (itemsBySize.get(it.sizeId) ?? 0) + it.qtyPlan,
      );
    }
  }
  const uniqueOrderSizeIds = Array.from(itemsBySize.keys());

  const rows: OrderOperationTableRow[] = [];
  // Локальный snapshot шагов, отсортированный по index — чтобы UI
  // строго совпадал с `OrderRouteStepDto.index`. Snapshot заказа
  // хранится в БД отсортированно, но защитимся от случаев, когда
  // backend отдаёт шаги в произвольном порядке.
  const sortedSteps = [...routeSteps].sort((a, b) => a.index - b.index);

  for (const step of sortedSteps) {
    const op = operationsById.get(step.operationId) ?? null;
    const balanceLine = balanceByOperationId?.get(step.operationId);

    const buckets = resolvePassportBuckets(step.index, passports);
    const plannedQty = qtyPlanTotal;
    const waitingQty = Math.max(
      0,
      plannedQty - buckets.completed - buckets.inProgress,
    );

    const status = deriveStatus(plannedQty, {
      waiting: waitingQty,
      inProgress: buckets.inProgress,
      completed: buckets.completed,
    });

    // Раскладка тиража на «своё» и «на стороне» — считается ДО денег:
    // на ней ветвятся и цена, и стоимость, и warnings строки.
    const split = resolveOutsourceSplit(step, itemsBySize, plannedQty);

    const norm = resolveNormLabel(op, itemsBySize, uniqueOrderSizeIds, step);
    const price = resolvePriceLabel(op, uniqueOrderSizeIds, step, split);
    const cost = resolveCost(op, norm.totalTimeSec, step, split);

    const warnings = new Set<string>();
    for (const w of norm.warnings) warnings.add(w);
    for (const w of price.warnings) warnings.add(w);
    for (const w of cost.warnings) warnings.add(w);
    for (const w of split.warnings) warnings.add(w);
    if (balanceLine && balanceLine.warnings.length > 0) {
      for (const w of balanceLine.warnings) warnings.add(w);
    }
    if (passports.length === 0) {
      // На MVP без паспортов мы не можем посчитать факт; оставляем
      // статус «Ожидает» (см. resolvePassportBuckets / deriveStatus),
      // а в комментарий добавим warning, что данных недостаточно для
      // точной картинки фактического выпуска.
      warnings.add('Недостаточно данных для статуса (нет паспортов)');
    }

    // Если backend дал точное `workSec` через production-balance — не
    // конкурируем с ним: показываем balance-значение в подсказке, но
    // в таблице рисуем web-side `totalTimeSec`. Это сознательно: ТЗ
    // §6 требует «Σ qtyBySize × timeNormSecForSize» на web, без
    // изменения backend formulas.
    const totalTimeSec = norm.totalTimeSec;

    rows.push({
      id: step.id,
      routeStepIndex: step.index,
      rowNumber: step.index + 1,
      operationId: step.operationId,
      operationName: step.operationName,
      operationCode: step.operationCode,
      statusLabel: status.label,
      statusTone: status.tone,
      plannedQty,
      waitingQty,
      inProgressQty: buckets.inProgress,
      completedQty: buckets.completed,
      normLabel: norm.label,
      priceLabel: price.label,
      // Эффективный способ оплаты (с учётом переопределения заказа) —
      // чтобы data-attribute/tooltip совпадали с тем, что показано.
      pricingMode: op ? (step.pricingModeOverride ?? op.pricingMode) : null,
      timeNormMode: op?.timeNormMode ?? null,
      totalTimeSec,
      lineTotalRub: cost.lineTotalRub,
      costFallbackLabel: cost.fallbackLabel,
      isOutsourced: split.active,
      outsourcedQty: split.outQtyTotal,
      outsourcePriceRub: split.priceRub,
      // `null` вместо 0 у обычной операции — чтобы «в т.ч. размещение»
      // не появлялось нулевой строкой там, где подряда нет вовсе.
      outsourceCostRub: split.active ? split.costRub : null,
      commentText: null,
      warnings: Array.from(warnings),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface OrderOperationsSummary {
  /** Σ `lineTotalRub` по всем строкам, у которых есть стоимость. `null`,
   *  если ни одной строки с посчитанной стоимостью. */
  totalCostRub: number | null;
  /** Σ `outsourceCostRub` по операциям на стороне — «в том числе
   *  размещение» ВНУТРИ `totalCostRub`, а не добавка к нему. `null`, если
   *  подряда в заказе нет. Нужен как fallback, пока backend не пересчитал
   *  снимок `Order.operationOutsourceCostPlanRub`. */
  totalOutsourceCostRub: number | null;
  /** Σ `totalTimeSec` по всем строкам с посчитанным временем. `null` ⇔ ничего. */
  totalTimeSec: number | null;
  /** Имя «узкого места» (если есть). */
  bottleneckOperationName: string | null;
  /** Сколько строк имеют warnings (для UI «есть пропуски в данных»). */
  rowsWithWarnings: number;
}

/**
 * Считает компактный итог под таблицей. На MVP мы предпочитаем взять
 * сводные значения из снепшота `Order.operationCostPlanRub` /
 * `operationTimePlanSec`, если они есть — это ровно то, что
 * `OrderOperationPlanService` посчитал на backend. Web-side сумма
 * по строкам остаётся только для случая, когда snapshot пуст.
 */
export function summariseOrderOperationRows(
  rows: OrderOperationTableRow[],
): OrderOperationsSummary {
  let cost = 0;
  let costSeen = false;
  let outsource = 0;
  let outsourceSeen = false;
  let time = 0;
  let timeSeen = false;
  let withWarnings = 0;
  let bottleneck: { name: string; sec: number } | null = null;
  for (const r of rows) {
    if (r.lineTotalRub != null && Number.isFinite(r.lineTotalRub)) {
      cost += r.lineTotalRub;
      costSeen = true;
    }
    if (r.outsourceCostRub != null && Number.isFinite(r.outsourceCostRub)) {
      // Складываем ТОЛЬКО расшифровку размещения; в `cost` она уже вошла
      // строкой целиком (`lineTotalRub` = своё + размещение).
      outsource += r.outsourceCostRub;
      outsourceSeen = true;
    }
    if (r.totalTimeSec != null && Number.isFinite(r.totalTimeSec)) {
      time += r.totalTimeSec;
      timeSeen = true;
      if (!bottleneck || r.totalTimeSec > bottleneck.sec) {
        bottleneck = { name: r.operationName, sec: r.totalTimeSec };
      }
    }
    if (r.warnings.length > 0) withWarnings += 1;
  }
  return {
    totalCostRub: costSeen ? cost : null,
    totalOutsourceCostRub: outsourceSeen ? outsource : null,
    totalTimeSec: timeSeen ? time : null,
    bottleneckOperationName: bottleneck?.name ?? null,
    rowsWithWarnings: withWarnings,
  };
}
