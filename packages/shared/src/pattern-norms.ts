/**
 * НОРМА РАСХОДА ИЗ НОМЕНКЛАТУРЫ → строка спецификации заказа.
 *
 * Зачем модуль существует. Нормы живут в карточке номенклатуры (лекала):
 * «Фурнитура и нормы» (`PatternItemParameterNorm.qtyPerItem`), «Погонные метры
 * по размерам» (`PatternItemSizeParameterValue`, `LINEAR_M_BY_SIZE`) и площади
 * (`PatternMaterialArea`, м² по размерам). Потребность цеха считает по ним —
 * а вот в спецификацию техкарты заказа они не попадали: кнопка «Подтянуть из
 * номенклатуры» в шаблоне переносит только СТРУКТУРУ строки и ставит норму `1`.
 * Менеджер видел `1`, закупка считалась по номенклатуре — два разных числа про
 * один материал. Этот модуль — единственное правило, по которому строка
 * спецификации находит свой источник и берёт из него число.
 *
 * Правило сопоставления — зеркало `WorkshopNeedsService.findEnrichmentLine`
 * (там ищут «строку для параметра», здесь — «параметр для строки»), но с
 * важной поправкой: обратное направление НЕЛЬЗЯ решать пер-строчно. Если у
 * роли `PACKAGING` один источник «Молния» и три строки (молния, шнур,
 * наконечник), пер-строчный fallback «единственный кандидат по роли» отдал бы
 * норму молнии всем трём. Поэтому сопоставление — ПАРНОЕ и жадное:
 *   1) точное совпадение имени параметра с `fabricType`/`name` строки;
 *   2) остаток: роль, где ровно один свободный источник и ровно одна свободная
 *      строка;
 *   3) иначе — не угадываем.
 *
 * Единицы. Строка получает источник, только когда способна принять его число
 * КАК ЕСТЬ. У фурнитуры это совпадение единиц («шт» ↔ «шт»), у поразмерных норм
 * — метры (для площадей м²), потому что там `unit` описывает не число, а
 * единицу будущей закупки. Строка в «кг» поразмерную норму НЕ получает: перевод
 * метров в килограммы требует ширины рулона и плотности и делается расчётом
 * потребности, а не спецификацией. Подробнее — у `isNormUnitCompatible`.
 *
 * Модуль чистый (никаких Decimal/Prisma): вход — числа, выход — числа,
 * округление до 4 знаков, как у `Decimal(12,4)` в БД.
 */

export type PatternNormKind =
  | 'QTY_PER_ITEM'
  | 'LINEAR_M_BY_SIZE'
  | 'AREA_M2_BY_SIZE';

/** Источник нормы в карточке номенклатуры. */
export interface PatternNormSource {
  /**
   * Трассировка (`OrderMaterialRequirement.qtySourceRef`):
   * `PatternItemParameterNorm.id` / `PatternCategoryParameter.id` (погонные
   * метры) / `materialRole` (площади — они группируются по роли).
   */
  sourceId: string;
  kind: PatternNormKind;
  /** `roleKey` параметра категории: MAIN_FABRIC / PACKAGING / RIB / … */
  roleKey: string;
  /** Имя параметра номенклатуры («Молния»). У площадей имени нет — `null`. */
  label: string | null;
  /** Единица параметра: «шт» / «м пог.» / «м²». */
  unit: string | null;
  /** Плоская норма на изделие — только для `QTY_PER_ITEM`. */
  qtyPerItem?: number | null;
  /** Значения по размерам — для `LINEAR_M_BY_SIZE` / `AREA_M2_BY_SIZE`. */
  bySize?: ReadonlyArray<{ sizeId: string; value: number }>;
}

/** Строка спецификации, которой ищем источник. */
export interface MaterialLineForMatch {
  /** Ключ строки у вызывающего (id снимка / индекс) — вернём его же в паре. */
  key: string;
  materialRole: string | null;
  name: string | null;
  fabricType: string | null;
  unit: string | null;
}

/** План по размерам расцветки — по нему считается средневзвешенная норма. */
export interface SizePlanEntry {
  sizeId: string;
  qtyPlan: number;
}

export interface DerivedNorm {
  /** Норма на изделие, округлённая до 4 знаков. */
  qtyPerUnit: number;
  /** Разбивка по размерам (пусто для плоской нормы) — для показа источника. */
  bySize: Array<{ sizeId: string; value: number; qtyPlan: number }>;
}

/** trim → lowercase → схлопнуть пробелы → ё→е (как в workshop-needs). */
function normalizeKey(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е');
}

/**
 * Единица к каноническому виду: «м пог.» / «м.пог» / «мп» → `м` (погонный метр
 * это и есть метр — писать их разными единицами значит развести один материал
 * на два); «м²» / «м2» / «кв м» → `м2`.
 *
 * Точки и пробелы снимаются ДО сравнения, поэтому в списках сравниваем уже
 * сжатые формы (`квм`, а не `кв.м`).
 */
function normalizeUnit(s: string | null | undefined): string {
  const raw = normalizeKey(s).replace(/[.\s]/g, '');
  if (raw === 'м2' || raw === 'м²' || raw === 'квм') return 'м2';
  if (raw === 'м' || raw === 'мпог' || raw === 'мп' || raw === 'погм') return 'м';
  return raw;
}

/**
 * Совместима ли единица строки с единицей источника.
 *
 * ПРАВИЛО РАЗНОЕ ПО ВИДУ НОРМЫ, и это не небрежность — у видов разный смысл
 * поля `unit`:
 *
 *   - `QTY_PER_ITEM` («Фурнитура и нормы») — `unit` это единица САМОГО ЧИСЛА
 *     («Молния, 1 шт»). Её и сравниваем с единицей строки.
 *
 *   - `LINEAR_M_BY_SIZE` / `AREA_M2_BY_SIZE` — `unit` это ЕДИНИЦА ПОТРЕБНОСТИ,
 *     то есть в чём материал попадёт в закупку, а НЕ единица введённых чисел.
 *     В ячейках всегда лежат погонные метры на изделие (для площадей — м²),
 *     см. `WorkshopNeedsService` и `PatternCategoryParameter.allowedUnits`.
 *     Параметр «Кулирка» с единицей «кг» означает «эти метры пересчитать в
 *     килограммы через ширину рулона и плотность», а не «здесь килограммы».
 *     Поэтому сравнивать `source.unit` с единицей строки здесь НЕЛЬЗЯ: строка
 *     принимает число как есть, значит она обязана быть в метрах (в м²).
 *
 * Цена ошибки тут несимметрична и уже была заплачена: правка, сравнившая
 * единицы у поразмерных норм, спарила строку в «кг» с метровыми значениями и
 * положила длину в килограммовое поле — на боевом заказе 808 вместо 343,8 кг.
 * Отсюда правило: единицу источника спрашиваем только у того вида, где она
 * описывает число.
 *
 * Пересчёт единиц здесь СОЗНАТЕЛЬНО не делаем — он требует ширины рулона и
 * плотности и живёт в расчёте потребности. Если строка спецификации ведётся в
 * закупочной единице, а норма нужна в метрах, это решается не тут, а
 * расщеплением «единица нормы» / «единица закупки» на самой строке.
 */
export function isNormUnitCompatible(
  lineUnit: string | null | undefined,
  source: Pick<PatternNormSource, 'kind' | 'unit'>,
): boolean {
  const line = normalizeUnit(lineUnit);
  if (line === '') return false;
  switch (source.kind) {
    case 'LINEAR_M_BY_SIZE':
      // `normalizeUnit` уже свёл «м пог.» к «м», поэтому одно сравнение.
      return line === 'м';
    case 'AREA_M2_BY_SIZE':
      return line === 'м2';
    case 'QTY_PER_ITEM': {
      const src = normalizeUnit(source.unit);
      return src === '' || src === line;
    }
    default:
      return false;
  }
}

/**
 * Сопоставить строки спецификации с источниками норм — ПАРНО и жадно.
 * Возвращает `Map<line.key, PatternNormSource>`; строки без источника в мапу
 * не попадают (у них норма останется из шаблона / из заказа).
 */
export function matchPatternNormSources(
  lines: ReadonlyArray<MaterialLineForMatch>,
  sources: ReadonlyArray<PatternNormSource>,
): Map<string, PatternNormSource> {
  const result = new Map<string, PatternNormSource>();
  if (lines.length === 0 || sources.length === 0) return result;

  const freeLines = lines.filter(
    (l) => l.materialRole != null && l.materialRole !== '',
  );
  const takenLines = new Set<string>();
  const takenSources = new Set<string>();

  const compatible = (l: MaterialLineForMatch, s: PatternNormSource): boolean =>
    l.materialRole === s.roleKey && isNormUnitCompatible(l.unit, s);

  // 1) Точное совпадение имени параметра со строкой.
  for (const s of sources) {
    const target = normalizeKey(s.label);
    if (target === '') continue;
    const hit = freeLines.find(
      (l) =>
        !takenLines.has(l.key) &&
        compatible(l, s) &&
        (normalizeKey(l.fabricType) === target || normalizeKey(l.name) === target),
    );
    if (!hit) continue;
    result.set(hit.key, s);
    takenLines.add(hit.key);
    takenSources.add(s.sourceId);
  }

  // 2) Имя параметра — начало названия строки: «Молния» ↔ «Молния разъёмная
  //    60 см». Так пишут техкарты, собранные руками (в подтянутых из
  //    номенклатуры `fabricType` совпадает точно и хватило шага 1). Берём
  //    пару, ТОЛЬКО если она взаимно однозначна: источник нашёл ровно одну
  //    строку И эта строка подошла ровно одному источнику.
  const pairs: Array<{ line: MaterialLineForMatch; source: PatternNormSource }> =
    [];
  for (const s of sources) {
    if (takenSources.has(s.sourceId)) continue;
    const target = normalizeKey(s.label);
    if (target === '') continue;
    for (const l of freeLines) {
      if (takenLines.has(l.key) || !compatible(l, s)) continue;
      const name = normalizeKey(l.name);
      const fabric = normalizeKey(l.fabricType);
      const startsWith = (v: string) =>
        v === target || v.startsWith(`${target} `);
      if (startsWith(name) || startsWith(fabric)) pairs.push({ line: l, source: s });
    }
  }
  for (const pair of pairs) {
    const perSource = pairs.filter(
      (p) => p.source.sourceId === pair.source.sourceId,
    );
    const perLine = pairs.filter((p) => p.line.key === pair.line.key);
    if (perSource.length !== 1 || perLine.length !== 1) continue;
    if (takenLines.has(pair.line.key) || takenSources.has(pair.source.sourceId)) {
      continue;
    }
    result.set(pair.line.key, pair.source);
    takenLines.add(pair.line.key);
    takenSources.add(pair.source.sourceId);
  }

  // 3) Остаток по роли: ровно один свободный источник ↔ ровно одна свободная
  //    строка. Иначе не угадываем — лучше «нет источника», чем чужое число.
  const roles = new Set<string>(sources.map((s) => s.roleKey));
  for (const role of roles) {
    const restSources = sources.filter(
      (s) => s.roleKey === role && !takenSources.has(s.sourceId),
    );
    if (restSources.length !== 1) continue;
    const s = restSources[0]!;
    const restLines = freeLines.filter(
      (l) => !takenLines.has(l.key) && compatible(l, s),
    );
    if (restLines.length !== 1) continue;
    const l = restLines[0]!;
    result.set(l.key, s);
    takenLines.add(l.key);
    takenSources.add(s.sourceId);
  }

  return result;
}

/** Округление до 4 знаков (как `Decimal(12,4)` в БД), без -0. */
function round4(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Вывести норму НА ИЗДЕЛИЕ из источника и размерного плана расцветки.
 *
 * Плоская норма (`QTY_PER_ITEM`) отдаётся как есть. Поразмерная —
 * средневзвешенной по плану: `Σ(value × qtyPlan) / Σ(qtyPlan)`. Именно
 * средневзвешенная, а не среднее арифметическое: тираж из 90 S и 10 XL должен
 * тянуть к норме S. Размеры без значения в номенклатуре в знаменатель не
 * попадают — иначе один незаполненный размер занизил бы норму на весь тираж.
 *
 * `null` — источник ничего не даёт (нет числа / нет пересечения с планом):
 * вызывающий оставляет норму шаблона.
 */
export function derivePatternNormPerUnit(
  source: PatternNormSource,
  sizePlan: ReadonlyArray<SizePlanEntry>,
): DerivedNorm | null {
  if (source.kind === 'QTY_PER_ITEM') {
    const v = source.qtyPerItem;
    if (v == null || !Number.isFinite(v) || v <= 0) return null;
    return { qtyPerUnit: round4(v), bySize: [] };
  }

  const values = source.bySize ?? [];
  if (values.length === 0) return null;
  const valueBySize = new Map(values.map((v) => [v.sizeId, v.value] as const));

  const bySize: DerivedNorm['bySize'] = [];
  let weighted = 0;
  let qty = 0;
  for (const p of sizePlan) {
    const value = valueBySize.get(p.sizeId);
    if (value == null || !Number.isFinite(value) || value <= 0) continue;
    bySize.push({ sizeId: p.sizeId, value, qtyPlan: p.qtyPlan });
    if (p.qtyPlan <= 0) continue;
    weighted += value * p.qtyPlan;
    qty += p.qtyPlan;
  }
  if (qty <= 0) {
    // План пуст (или все размеры с нулём), но значения есть — берём среднее
    // арифметическое по заполненным размерам: лучше разумная норма, чем 1.
    const filled = bySize.filter((b) => b.value > 0);
    if (filled.length === 0) return null;
    const avg = filled.reduce((s, b) => s + b.value, 0) / filled.length;
    return { qtyPerUnit: round4(avg), bySize };
  }
  return { qtyPerUnit: round4(weighted / qty), bySize };
}

/** Подпись источника для UI: «Молния · из номенклатуры». */
export function describePatternNormSource(
  source: Pick<PatternNormSource, 'kind' | 'label' | 'unit'>,
): string {
  const kind =
    source.kind === 'QTY_PER_ITEM'
      ? 'норма на изделие'
      : source.kind === 'LINEAR_M_BY_SIZE'
        ? 'погонные метры по размерам'
        : 'площадь по размерам';
  return source.label ? `${source.label} · ${kind}` : kind;
}
