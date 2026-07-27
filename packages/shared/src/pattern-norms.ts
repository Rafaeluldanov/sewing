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
 * Единицы. Число из номенклатуры имеет смысл только в своей единице: «шт» для
 * фурнитуры, «м пог.» для погонных метров, «м²» для площадей. Строка с другой
 * единицей (полотно в «м») источник НЕ получает — лучше оставить норму шаблона,
 * чем подставить в метры площадь. Пересчёт единиц сознательно не делаем: он
 * требует ширины рулона и плотности, и это работа расчёта потребности, а не
 * спецификации.
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

/** «м пог.» / «м.пог» / «мп» → `мпог`; «м²»/«м2» → `м2`. */
function normalizeUnit(s: string | null | undefined): string {
  const raw = normalizeKey(s).replace(/[.\s]/g, '');
  if (raw === 'м2' || raw === 'м²' || raw === 'кв.м' || raw === 'кв м') {
    return 'м2';
  }
  if (raw === 'мпог' || raw === 'мп' || raw === 'погм') return 'мпог';
  return raw;
}

/**
 * Совместима ли единица строки с единицей источника.
 *
 * Погонные метры пишут и как «м», и как «м пог.» — считаем это одним и тем же.
 * Площадь принимает только «м²/м2». Штучная норма требует совпадения единиц
 * (или молчащей единицы у источника).
 */
export function isNormUnitCompatible(
  lineUnit: string | null | undefined,
  source: Pick<PatternNormSource, 'kind' | 'unit'>,
): boolean {
  const line = normalizeUnit(lineUnit);
  if (line === '') return false;
  switch (source.kind) {
    case 'AREA_M2_BY_SIZE':
      return line === 'м2';
    case 'LINEAR_M_BY_SIZE':
      return line === 'м' || line === 'мпог';
    case 'QTY_PER_ITEM': {
      const src = normalizeUnit(source.unit);
      return src === '' ? true : src === line;
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
