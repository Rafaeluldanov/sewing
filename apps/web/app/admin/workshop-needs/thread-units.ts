/**
 * Конверсия единиц для строк потребности по НИТКАМ
 * (`materialRole === 'THREAD'`).
 *
 * Бизнес-контекст: расход ниток система считает и хранит в погонных
 * метрах (`unit === 'м пог.'`, см.
 * `apps/api/src/modules/workshop-needs/workshop-needs.service.ts`), но
 * закупщик работает в «ярдах» и покупает нитки бобинами
 * (1 бобина = 4000 ярдов). Бэкенд / себестоимость / склад остаются в
 * метрах — поэтому конверсия живёт ТОЛЬКО на фронте формы
 * `/admin/workshop-needs`:
 *
 *   - «Нужно» / «К закупке» показываем в ярдах   (`метры / 0.9144`);
 *   - подпись поля цены — «Цена за 1 боб.»        (цена за бобину);
 *   - «Сумма» = `(ярды / 4000) × цена за бобину`;
 *   - при сохранении конвертируем обратно:
 *       ярды → метры                (`ярды × 0.9144`)
 *       цена за бобину → цена за метр (`цена / (4000 × 0.9144)`).
 *
 * Точный текстильный коэффициент: 1 ярд = 0.9144 м.
 *
 * Применяется только к ниткам — остальные единицы (шт / м² / кг /
 * компл) не трогаем (см. `isThreadNeed`).
 */

/** 1 ярд = 0.9144 м (точный международный коэффициент). */
export const M_PER_YARD = 0.9144;

/** Бобина ниток = 4000 ярдов. */
export const YARDS_PER_BOBBIN = 4000;

/** 1 бобина в метрах = 4000 × 0.9144 = 3657.6 м. */
export const M_PER_BOBBIN = YARDS_PER_BOBBIN * M_PER_YARD;

/**
 * Строка потребности — нитки? Единственный надёжный сигнал —
 * `materialRole`, см. `getWorkshopNeedKind` в
 * `@sewing/shared/workshop-needs`.
 */
export function isThreadNeed(
  materialRole: string | null | undefined,
): boolean {
  return materialRole === 'THREAD';
}

/**
 * Парсит decimal-строку («3657,6» / «3657.6» / «» / null) в число.
 * Возвращает `null`, если значение пустое или не число.
 */
function parse(value: string | null | undefined): number | null {
  if (value == null) return null;
  const raw = value.trim().replace(',', '.');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Форматирует число в decimal-строку без «хвоста» нулей. До 6 знаков
 * после запятой — этого с запасом хватает, чтобы round-trip
 * метры↔ярды и цена/м↔цена/боб не «плыл» на отредактированных полях.
 * (Неотредактированные поля и так сохраняются исходным значением —
 * см. inline-edit-row.)
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(6);
  return s.includes('.') ? s.replace(/0+$/u, '').replace(/\.$/u, '') : s;
}

/** Метры (строка) → ярды (строка). Пустое/невалидное → ''. */
export function metersToYards(meters: string | null | undefined): string {
  const n = parse(meters);
  return n === null ? '' : fmt(n / M_PER_YARD);
}

/** Ярды (строка) → метры (строка). Пустое/невалидное → ''. */
export function yardsToMeters(yards: string | null | undefined): string {
  const n = parse(yards);
  return n === null ? '' : fmt(n * M_PER_YARD);
}

/** Цена за метр (строка) → цена за бобину (строка). */
export function pricePerMeterToBobbin(
  pricePerMeter: string | null | undefined,
): string {
  const n = parse(pricePerMeter);
  return n === null ? '' : fmt(n * M_PER_BOBBIN);
}

/** Цена за бобину (строка) → цена за метр (строка). */
export function pricePerBobbinToMeter(
  pricePerBobbin: string | null | undefined,
): string {
  const n = parse(pricePerBobbin);
  return n === null ? '' : fmt(n / M_PER_BOBBIN);
}
