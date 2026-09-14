/**
 * Упаковочный режим строк потребности по КНОПКАМ.
 *
 * Бизнес-контекст: расход кнопок система считает и хранит поштучно
 * (`unit === 'шт'`), но закупщик покупает их упаковками. На форме
 * `/admin/workshop-needs` для кнопок поле «К закупке» заменяется на
 * три поля:
 *
 *   - «Упаковок»         — количество упаковок к закупке;
 *   - «Шт/упак»          — штук в одной упаковке (`WorkshopNeed.packSize`);
 *   - «Цена за упаковку» — вместо «Цена за 1 шт».
 *
 * «Сумма» = упаковок × цена за упаковку.
 *
 * В БД / себестоимости / складе всё остаётся поштучно — конверсия
 * живёт на фронте формы:
 *
 *   - `purchaseQty` (шт)   = упаковок × штук_в_упаковке;
 *   - `quotedPrice` (за 1 шт) = округл(цена_за_упаковку ÷ штук_в_упаковке, 4);
 *   - `packSize`           = штук_в_упаковке — сохраняется отдельной
 *     колонкой, чтобы при перезагрузке восстановить разбивку (из одной
 *     цифры «штук» её не вывести).
 *
 * Замечание о точности (аудит движка расчёта 13.09.2026, N2-13): цена
 * за штуку округляется до 4 знаков — ровно как хранит `quotedPrice`
 * (Decimal(14,4)) и как считают нитки (`./thread-units`). Раньше было
 * 2 знака «кнопкам хватает копеек», но отклонение за упаковку равно
 * packSize × 0,005 ₽ (упаковка 1000 шт за 37 ₽ → 0,04 ₽/шт → 40 ₽ в
 * смете, +8 %), а цена дешевле 0,005 ₽/шт становилась нулём и смета
 * вставала на «Цена должна быть > 0». Если «цена за упаковку» не
 * делится на «штук в упаковке» нацело, при перезагрузке «цена за
 * упаковку» может отличаться на доли копейки (напр. 100 ₽ / 12 шт →
 * 8.3333 ₽/шт → 99.9996 ₽ → показывается как 100). Для делящихся
 * нацело цен (обычный кейс) round-trip точный. Само отображение «цена
 * за упаковку» остаётся с 2 знаками.
 *
 * В отличие от ниток (см. `./thread-units`), «штук в упаковке» —
 * переменная, её вводит закупщик, поэтому она и хранится в БД.
 * Применяется ТОЛЬКО к кнопкам (`isButtonNeed`): прочая фурнитура
 * (молнии, пуговицы, люверсы) и остальные единицы не затрагиваются.
 *
 * Режим упаковок включается только при СОХРАНЁННОМ `packSize`
 * (аудит движка расчёта 13.09.2026, N2-1): `purchaseQty`/`quotedPrice`
 * пишут и ERP (`:price`/`:qty`), и окно правки во вкладке заказа — без
 * `packSize`. Пока «Шт/упак» не задан, из штук упаковки не вывести,
 * поэтому такая строка показывает обычные «К закупке» / «Цена за 1 шт»
 * с исходными значениями плюс поле «Шт/упак»; после его сохранения
 * строка перезагружается уже в упаковках. Поля упаковочного режима
 * уходят на backend только если их тронули — см. `packFieldToSubmit`.
 */

/**
 * Строка потребности — кнопки? Кнопки идут с `materialRole = PACKAGING`
 * (как вся фурнитура), поэтому дополнительно проверяем имя строки /
 * описание на «кнопк». Отдельного типа фурнитуры в БД нет (см.
 * `WorkshopNeedsService` — фурнитура различается по `sourceName`).
 */
export function isButtonNeed(
  materialRole: string | null | undefined,
  sourceName: string | null | undefined,
  description: string | null | undefined,
): boolean {
  if (materialRole !== 'PACKAGING') return false;
  const hay = `${sourceName ?? ''} ${description ?? ''}`.toLowerCase();
  return hay.includes('кнопк');
}

/** Парсит decimal-строку («10» / «8,33» / «» / null) в число. */
function parse(value: string | null | undefined): number | null {
  if (value == null) return null;
  const raw = value.trim().replace(',', '.');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Число → строка без хвостовых нулей, до 4 знаков (как у Decimal qty). */
function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/u, '').replace(/\.$/u, '') : s;
}

/** Число → денежная строка для ОТОБРАЖЕНИЯ, округление до 2 знаков. */
function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(2);
  return s.replace(/0+$/u, '').replace(/\.$/u, '');
}

/**
 * Число → цена за 1 шт для backend, 4 знака (как Decimal(14,4)
 * `quotedPrice`). Аудит движка расчёта 13.09.2026, N2-13: 2 знака
 * искажали сумму за крупную упаковку и обнуляли цену дешевле 0,005 ₽/шт.
 */
function fmtUnitPrice(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(4);
  return s.replace(/0+$/u, '').replace(/\.$/u, '');
}

/** Упаковок + штук в упаковке → штук (для backend `purchaseQty`). */
export function packagesToPieces(
  packages: string | null | undefined,
  packSize: string | null | undefined,
): string {
  const p = parse(packages);
  const s = parse(packSize);
  return p === null || s === null ? '' : fmtQty(p * s);
}

/** Штук + штук в упаковке → упаковок (для отображения «Упаковок»). */
export function piecesToPackages(
  pieces: string | null | undefined,
  packSize: string | null | undefined,
): string {
  const p = parse(pieces);
  const s = parse(packSize);
  return p === null || s === null || s === 0 ? '' : fmtQty(p / s);
}

/** Цена за упаковку + штук в упаковке → цена за 1 шт (backend `quotedPrice`). */
export function pricePerPackToPiece(
  pricePerPack: string | null | undefined,
  packSize: string | null | undefined,
): string {
  const price = parse(pricePerPack);
  const s = parse(packSize);
  return price === null || s === null || s === 0
    ? ''
    : fmtUnitPrice(price / s);
}

/** Цена за 1 шт + штук в упаковке → цена за упаковку (для отображения). */
export function pricePerPieceToPack(
  pricePerPiece: string | null | undefined,
  packSize: string | null | undefined,
): string {
  const price = parse(pricePerPiece);
  const s = parse(packSize);
  return price === null || s === null ? '' : fmtMoney(price * s);
}

/**
 * Режим упаковок для кнопочной строки: «Шт/упак» уже сохранён в БД.
 * Аудит движка расчёта 13.09.2026, N2-1: без сохранённого `packSize`
 * поля «Упаковок»/«Цена за упаковку» показывались пустыми при живых
 * `purchaseQty`/`quotedPrice` и любое сохранение их стирало.
 */
export function isPackMode(
  isButton: boolean,
  storedPackSize: string | null | undefined,
): boolean {
  return isButton && (storedPackSize ?? '').trim() !== '';
}

/**
 * Что отправить на backend в поле `purchaseQty` / `quotedPrice` для
 * кнопочной строки в режиме упаковок (аудит движка расчёта
 * 13.09.2026, N2-1).
 *
 * На backend пустое значение означает «очистить поле», а отсутствие
 * поля — «не трогать» (`trackOptional`: absent → changed=false).
 * Раньше поля уходили на КАЖДОЕ сохранение, и пустота, возникшая не
 * из-за закупщика, трактовалась как «стёр»: правка одного статуса
 * обнуляла согласованные «К закупке» и цену. Теперь:
 *
 *   - `null` — НЕ отправлять: ни значение, ни «Шт/упак» не менялись,
 *     либо «Шт/упак» стёрт и пересчитать нечем;
 *   - `''`   — закупщик стёр значение сам, очистку передаём;
 *   - иначе  — поштучное значение через `convert`.
 *
 * Неизменённое поле не уходит ещё и затем, чтобы round-trip
 * штуки → упаковки → штуки не округлял число в БД (как у ниток).
 */
export function packFieldToSubmit(args: {
  /** Текущее значение поля «Упаковок» / «Цена за упаковку». */
  value: string;
  /** Значение того же поля при загрузке строки (из БД). */
  initialValue: string;
  /** Текущее «Шт/упак». */
  packSize: string;
  /** «Шт/упак» при загрузке строки (из БД). */
  initialPackSize: string;
  /** `packagesToPieces` либо `pricePerPackToPiece`. */
  convert: (value: string, packSize: string) => string;
}): string | null {
  const value = args.value.trim();
  const packSize = args.packSize.trim();
  const changed =
    value !== args.initialValue.trim() ||
    packSize !== args.initialPackSize.trim();
  if (!changed) return null;
  if (value === '') return '';
  if (packSize === '') return null;
  return args.convert(value, packSize);
}

/**
 * Что отправить на backend в поле `packSize` («Шт/упак») кнопочной строки
 * (аудит движка расчёта 13.09.2026, N2-1, ревью).
 *
 * Скрытое поле уходило на КАЖДОЕ сохранение (и в режиме упаковок, и без
 * него — пустой строкой), поэтому `trackOptional('packSize')` на backend
 * всегда считал поле изменённым: в логе/аудите правки статуса появлялся
 * `packSize`, а без упаковок писался null поверх null. Та же логика, что у
 * `packFieldToSubmit`:
 *
 *   - `null` — НЕ отправлять: значение как при загрузке строки;
 *   - `''`   — закупщик стёр «Шт/упак», очистку передаём;
 *   - иначе  — новое значение (trim).
 */
export function packSizeToSubmit(args: {
  /** Текущее «Шт/упак». */
  value: string;
  /** «Шт/упак» при загрузке строки (из БД). */
  initialValue: string;
}): string | null {
  const value = args.value.trim();
  if (value === args.initialValue.trim()) return null;
  return value;
}
