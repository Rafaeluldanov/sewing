/**
 * Локальные форматтеры значений для read-only таблиц склада
 * (`StockBalancesTable`, `StockMovementsTable`).
 *
 * Backend сериализует `Decimal` строкой через `.toString()` —
 * UI парсит её в `Number` ради `toLocaleString('ru-RU', ...)` и
 * fallback'ится на исходную строку, если число не представимо
 * (огромный Decimal). Это безопаснее, чем `Number.parseFloat`
 * без проверки.
 */

const NUMBER_LOCALE = 'ru-RU' as const;

/**
 * `Decimal` → «1 234,5» / «—». Используется для qty и
 * `balanceBefore/After`. До 4 знаков после запятой — этого
 * достаточно для метров / кг / штук.
 */
export function formatStockQty(
  value: string | number | null | undefined,
): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString(NUMBER_LOCALE, {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  });
}

/**
 * `Decimal` → «1 234,56 ₽» / «—». Используется для unitCost и
 * totalCost. Валюта в MVP захардкожена на `RUB`
 * (см. `StockService::resolvePurchaseReceiptLineUnitCost`).
 */
export function formatStockMoney(
  value: string | number | null | undefined,
): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString(NUMBER_LOCALE, {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  });
}

/**
 * ISO date-time строка → «25.04.2026, 14:35» / «—».
 * Используется для `createdAt`, `updatedAt`, `lastMovementAt` —
 * в журнале движений важно показать и время, не только день.
 */
export function formatStockDateTime(
  value: string | Date | null | undefined,
): string {
  if (value == null || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(NUMBER_LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Безопасно `Number()`-ит `Decimal`-строку для проверки знака
 * (`qty < 0` подсветка). На NaN возвращает `0` — visually это
 * нейтрально (без danger-подсветки), что лучше fallback-а в
 * случае мусорной строки.
 */
export function toStockNumber(value: string | number | null | undefined): number {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
