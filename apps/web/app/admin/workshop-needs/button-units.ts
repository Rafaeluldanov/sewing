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
 *   - `quotedPrice` (за 1 шт) = округл(цена_за_упаковку ÷ штук_в_упаковке, 2);
 *   - `packSize`           = штук_в_упаковке — сохраняется отдельной
 *     колонкой, чтобы при перезагрузке восстановить разбивку (из одной
 *     цифры «штук» её не вывести).
 *
 * Замечание о точности: `quotedPrice` хранится Decimal(14,2) — цена за
 * штуку округляется до 2 знаков. Если «цена за упаковку» не делится на
 * «штук в упаковке» нацело, при перезагрузке «цена за упаковку» может
 * отличаться на копейку (напр. 100 ₽ / 12 шт → 8.33 ₽/шт → 99.96 ₽).
 * Для делящихся нацело цен (обычный кейс) round-trip точный.
 *
 * В отличие от ниток (см. `./thread-units`), «штук в упаковке» —
 * переменная, её вводит закупщик, поэтому она и хранится в БД.
 * Применяется ТОЛЬКО к кнопкам (`isButtonNeed`): прочая фурнитура
 * (молнии, пуговицы, люверсы) и остальные единицы не затрагиваются.
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

/** Число → денежная строка, округление до 2 знаков (Decimal(14,2)). */
function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(2);
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
  return price === null || s === null || s === 0 ? '' : fmtMoney(price / s);
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
