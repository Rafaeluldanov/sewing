/**
 * НОРМА РАСХОДА → КОЛИЧЕСТВО К ЗАКУПКЕ.
 *
 * Зачем модуль существует. Строка спецификации несёт ДВА разных числа в двух
 * разных единицах, и раньше они делили одно поле. Расход — сколько материала
 * уходит на изделие; он приходит из номенклатуры поразмерно и живёт в единице
 * техкарты (длина). Закупка — сколько купить; трикотаж берут на вес, и это уже
 * другая единица. Поле `unit` строки исторически означает именно ЗАКУПОЧНУЮ
 * единицу: на нём висят сметы, складские балансы и правило обязательности
 * ширины/плотности. Поэтому единицу нормы вынесли в отдельное поле `normUnit`,
 * а этот модуль — единственное место, где из первой получается вторая.
 *
 * Формула зеркалит `WorkshopNeedsService` (ветки `outputUnit` при расчёте
 * потребности) и обязана оставаться с ней синхронной: если спецификация и
 * потребность посчитают закупку по-разному, мы вернём ровно ту болезнь, ради
 * которой всё затевалось — два числа про один материал.
 *
 *   м пог. → м пог.   как есть
 *   м пог. → м²       × ширина_см / 100
 *   м пог. → кг       × ширина_см / 100 × плотность_г/м² / 1000
 *
 * Нет ширины или плотности — пересчёт НЕ делаем и честно говорим об этом.
 * Молчаливый ноль или «то же число в другой единице» здесь хуже отказа: первое
 * прячет проблему, второе выдаёт длину за вес.
 *
 * Модуль чистый (никаких Decimal/Prisma): вход — числа, выход — числа,
 * округление до 4 знаков, как у `Decimal(12,4)` в БД.
 */

/** Причина, по которой пересчёт невозможен — её показываем менеджеру. */
export type NormPurchaseProblem =
  | 'NO_WIDTH'
  | 'NO_DENSITY'
  | 'UNSUPPORTED_UNIT'
  | 'NORM_NOT_LINEAR';

export interface NormPurchaseInput {
  /** Норма на изделие в `normUnit`. */
  normPerUnit: number;
  /** Единица нормы. Пересчёт умеет только из длины. */
  normUnit: string | null | undefined;
  /** Тираж группы (расцветки или заказа). */
  qty: number;
  /** Единица закупки — поле `unit` строки. */
  purchaseUnit: string | null | undefined;
  /** Ширина рулона, см. */
  widthCm?: number | null;
  /** Плотность, г/м². */
  densityGsm?: number | null;
}

export type NormPurchaseResult =
  | {
      ok: true;
      /** Расход в единице НОРМЫ: `normPerUnit × qty`. */
      totalNorm: number;
      /** Количество к закупке в `purchaseUnit`. */
      purchaseQty: number;
      /** Площадь, если она участвовала в пересчёте, — для показа цепочки. */
      areaM2: number | null;
      /** Человекочитаемая формула для примечания к строке. */
      formula: string;
    }
  | {
      ok: false;
      problem: NormPurchaseProblem;
      /** Расход в единице нормы считается всегда — он от пересчёта не зависит. */
      totalNorm: number;
      message: string;
    };

/** trim → lowercase → схлопнуть пробелы → ё→е (как в pattern-norms). */
function normalizeKey(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е');
}

/** «м пог.» / «мп» → `м`; «м²» / «кв м» → `м2`. Как в pattern-norms. */
function normalizeUnit(s: string | null | undefined): string {
  const raw = normalizeKey(s).replace(/[.\s]/g, '');
  if (raw === 'м2' || raw === 'м²' || raw === 'квм') return 'м2';
  if (raw === 'м' || raw === 'мпог' || raw === 'мп' || raw === 'погм') return 'м';
  return raw;
}

/** Округление до 4 знаков (как `Decimal(12,4)` в БД), без -0. */
function round4(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
}

/** Число пригодно как множитель — конечное и строго положительное. */
function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Нужен ли строке пересчёт: единица нормы отличается от единицы закупки.
 * Совпали — строка живёт как раньше, и колонка закупки просто повторяет расход.
 */
export function needsPurchaseConversion(
  normUnit: string | null | undefined,
  purchaseUnit: string | null | undefined,
): boolean {
  const n = normalizeUnit(normUnit);
  if (n === '') return false;
  return n !== normalizeUnit(purchaseUnit);
}

/**
 * Посчитать расход и количество к закупке.
 *
 * `totalNorm` возвращается ВСЕГДА, даже когда пересчёт невозможен: расход в
 * единице нормы от ширины и плотности не зависит, и прятать его из-за
 * незаполненной характеристики незачем.
 */
export function computeNormPurchase(
  input: NormPurchaseInput,
): NormPurchaseResult {
  const { normPerUnit, qty, widthCm, densityGsm } = input;
  const norm = Number.isFinite(normPerUnit) ? normPerUnit : 0;
  const count = Number.isFinite(qty) ? qty : 0;
  const totalNorm = round4(norm * count);

  const nUnit = normalizeUnit(input.normUnit);
  const pUnit = normalizeUnit(input.purchaseUnit);

  // Единицы совпали (или единица нормы не задана) — закупка равна расходу.
  if (nUnit === '' || nUnit === pUnit) {
    return {
      ok: true,
      totalNorm,
      purchaseQty: totalNorm,
      areaM2: null,
      formula: '',
    };
  }

  // Пересчитывать умеем только ИЗ длины: площадь и вес получаются из метров
  // через ширину рулона, обратного хода (вес → метры) здесь нет.
  if (nUnit !== 'м') {
    return {
      ok: false,
      problem: 'NORM_NOT_LINEAR',
      totalNorm,
      message: `Пересчёт в «${input.purchaseUnit}» умеет только из погонных метров, а норма задана в «${input.normUnit}».`,
    };
  }

  if (pUnit === 'м2' || pUnit === 'кг') {
    if (!positive(widthCm)) {
      return {
        ok: false,
        problem: 'NO_WIDTH',
        totalNorm,
        message:
          'Не указана ширина рулона — без неё погонные метры не пересчитать в закупочную единицу.',
      };
    }
    const areaM2 = round4((totalNorm * widthCm) / 100);
    if (pUnit === 'м2') {
      return {
        ok: true,
        totalNorm,
        purchaseQty: areaM2,
        areaM2,
        formula: `${totalNorm} м пог. × ${widthCm} см / 100 = ${areaM2} м²`,
      };
    }
    if (!positive(densityGsm)) {
      return {
        ok: false,
        problem: 'NO_DENSITY',
        totalNorm,
        message:
          'Не указана плотность — без неё погонные метры не пересчитать в килограммы.',
      };
    }
    const kg = round4((areaM2 * densityGsm) / 1000);
    return {
      ok: true,
      totalNorm,
      purchaseQty: kg,
      areaM2,
      formula: `${totalNorm} м пог. × ${widthCm} см / 100 × ${densityGsm} г/м² / 1000 = ${kg} кг`,
    };
  }

  // Штуки, каталки и прочее из метров не выводятся — тут нужен свой
  // коэффициент, которого у строки нет.
  return {
    ok: false,
    problem: 'UNSUPPORTED_UNIT',
    totalNorm,
    message: `Пересчёт погонных метров в «${input.purchaseUnit}» не поддерживается.`,
  };
}
