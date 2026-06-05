'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreateTechCardSchema,
  TECH_CARD_CODE_PATTERN,
  UpdateTechCardSchema,
  getTechCardMaterialRoleLabel,
  type OutsourceTriggerType,
  type TechCardOutsourceLineInputDto,
} from '@sewing/shared/tech-cards';
import { ApiRequestError } from '@/lib/api';
import { getPattern } from '@/lib/patterns-api';
import { getPatternCategory } from '@/lib/pattern-categories-api';
import {
  createTechCard,
  deleteTechCard,
  updateTechCard,
  uploadTechCardMaterialLineImage,
} from '@/lib/tech-cards-api';
import type {
  TechCardFormState,
  UploadMaterialImageState,
} from './form-state';

/**
 * Этап «Техкарта = материальные требования»: новая логика техкарты
 * хранит только материальные требования (роль / характеристика /
 * плотность / ширина / правило цвета), а нанесение и упаковка живут
 * вне техкарты (`OrderApplication` + операции маршрута). UI скрывает
 * legacy поля строки (`name`, `unit`, `qtyPerUnit`, `note`), но
 * shared schema на backend всё ещё считает их обязательными — поэтому
 * action подменяет пустые значения безопасными fallback-ами:
 *   - `name`        — `fabricType` либо человекочитаемый label роли,
 *                     иначе literal «Материал»;
 *   - `unit`        — `'кг'`;
 *   - `qtyPerUnit`  — `'1'` (положительное число > 0, требуется
 *                     `TechCardMaterialLineInputSchema.qtyPerUnit`);
 *   - `note`        — `null` (не передаётся).
 *
 * Старые техкарты, у которых эти поля заполнены реальными значениями,
 * сохраняют их через hidden inputs формы — fallback срабатывает только
 * когда поле пришло пустым.
 */

/** Если строка пустая (нет ни одного «значимого» поля), пропускаем её. */
const QTY_PER_UNIT_FALLBACK = '1';
const UNIT_FALLBACK = 'кг';
const NAME_FALLBACK = 'Материал';

function fallbackMaterialName(opts: {
  fabricType: string | null;
  materialRole: string | null;
}): string {
  if (opts.fabricType && opts.fabricType.length > 0) return opts.fabricType;
  const role = opts.materialRole;
  if (role) {
    // `getTechCardMaterialRoleLabel` знает и whitelist категорий
    // (`PATTERN_CATEGORY_PARAMETER_GROUPS`), и legacy roleKey-и
    // (`MATERIAL_ROLE_LABELS`). Никогда не возвращает «Упаковка»
    // (см. ТЗ §1) — для PACKAGING вернёт «Фурнитура».
    const label = getTechCardMaterialRoleLabel(role);
    if (label) return label;
  }
  return NAME_FALLBACK;
}

/**
 * Парсит строки техкарты из FormData.
 *
 * UI рендерит динамический список строк с уникальными ключами вида
 * `material[<key>][name]`, `material[<key>][unit]` и т.д. (где `<key>`
 * — стабильный id строки в форме, а не sortOrder). Здесь мы собираем
 * пары по `<key>`, отсеиваем пустые «черновые» строки и сохраняем
 * порядок появления ключей в форме — backend нормализует `sortOrder`
 * как `(i + 1) * 10`. См. `TechCardsService.create/update`.
 */
function parseLines<T extends 'material' | 'outsource'>(
  form: FormData,
  prefix: T,
): T extends 'material'
  ? Array<Record<string, string>>
  : Array<Record<string, string>> {
  const re = new RegExp(`^${prefix}\\[([^\\]]+)\\]\\[([^\\]]+)\\]$`);
  const orderKeys: string[] = [];
  const seen = new Set<string>();
  const map = new Map<string, Record<string, string>>();
  for (const [key, rawVal] of form.entries()) {
    const m = re.exec(key);
    if (!m) continue;
    const [, lineKey, fieldName] = m;
    const value = String(rawVal ?? '').trim();
    if (!seen.has(lineKey)) {
      seen.add(lineKey);
      orderKeys.push(lineKey);
      map.set(lineKey, {});
    }
    const obj = map.get(lineKey);
    if (obj) obj[fieldName] = value;
  }
  return orderKeys
    .map((k) => map.get(k) as Record<string, string>)
    .filter((row) => Boolean(row));
}

/**
 * Сырой вход материал-строки до валидации `CreateTechCardSchema`.
 * Все поля строки/null/undefined — Zod-схема на backend и shared
 * пакет нормализуют значения (пустая строка → null, число из
 * `<input type="number">` приходит строкой и парсится в schema).
 *
 * Сознательно НЕ используем `Partial<TechCardMaterialLineInputDto>` —
 * `MaterialRole` / `TechCardMaterialColorRule` сужены до конкретных
 * литералов в DTO, а форма-RAW передаёт `string`. Точечный cast
 * сделал бы код шумным; вместо этого описываем форму вручную.
 */
type RawMaterialLineInput = {
  name: string;
  unit: string;
  qtyPerUnit: string;
  note: string;
  materialRole: string | null;
  fabricType: string | null;
  densityGsm: string | null;
  plannedWidthCm: string | null;
  colorRule: string | null;
  fixedColorText: string | null;
  // Этап «Фурнитура / изображение материала» (см. ТЗ §3, §5).
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  materialImageUrl: string | null;
  materialImageOriginalFileName: string | null;
};

function buildMaterialLines(form: FormData): RawMaterialLineInput[] {
  return parseLines(form, 'material')
    .map((r): RawMaterialLineInput | null => {
      // Этап «Техкарта = материальные требования»: новые «видимые»
      // поля строки. Пустая строка нормализуется к `null` (Zod-схема
      // на backend дополнительно нормализует — здесь fallback-логика).
      const trimOrNull = (k: keyof typeof r): string | null => {
        const v = (r[k] ?? '').trim();
        return v === '' ? null : v;
      };
      const materialRole = trimOrNull('materialRole');
      const fabricType = trimOrNull('fabricType');
      const densityGsm = trimOrNull('densityGsm');
      const plannedWidthCm = trimOrNull('plannedWidthCm');
      const colorRule = trimOrNull('colorRule');
      const fixedColorText = trimOrNull('fixedColorText');
      const hardwareSizeText = trimOrNull('hardwareSizeText');
      const hardwareMaterialText = trimOrNull('hardwareMaterialText');
      const materialImageUrl = trimOrNull('materialImageUrl');
      const materialImageOriginalFileName = trimOrNull(
        'materialImageOriginalFileName',
      );

      // Legacy поля больше не показываются пользователю — они едут
      // hidden-инпутами и могут содержать значения старой техкарты.
      // Если строка не пустая, но legacy-поля пусты, генерируем
      // безопасный fallback (см. doc-комментарий выше).
      const rawName = (r.name ?? '').trim();
      const rawUnit = (r.unit ?? '').trim();
      const rawQty = (r.qtyPerUnit ?? '').trim();
      const rawNote = (r.note ?? '').trim();

      // Полностью пустая строка (ни одного значимого поля + нет
      // legacy-значений) — это «черновой» row, который пользователь
      // добавил, но не заполнил. Не отправляем его на backend.
      const hasAnyContent =
        rawName.length > 0 ||
        rawUnit.length > 0 ||
        rawQty.length > 0 ||
        rawNote.length > 0 ||
        materialRole != null ||
        fabricType != null ||
        densityGsm != null ||
        plannedWidthCm != null ||
        colorRule != null ||
        fixedColorText != null ||
        hardwareSizeText != null ||
        hardwareMaterialText != null ||
        materialImageUrl != null ||
        materialImageOriginalFileName != null;
      if (!hasAnyContent) return null;

      const name =
        rawName.length > 0
          ? rawName
          : fallbackMaterialName({ fabricType, materialRole });
      const unit = rawUnit.length > 0 ? rawUnit : UNIT_FALLBACK;
      // `TechCardMaterialLineInputSchema.qtyPerUnit` требует число > 0.
      // Если значение отсутствует или равно `'0'` (легаси-выгрузка
      // перед валидацией) — подменяем на положительный sentinel `'1'`,
      // чтобы submit не падал. Сама нормa расхода теперь определяется
      // площадью полотна (`PatternMaterialArea`) и плотностью; это
      // legacy-поле остаётся в БД ради backward-compat.
      const qtyPerUnit =
        rawQty.length > 0 && rawQty !== '0' ? rawQty : QTY_PER_UNIT_FALLBACK;
      const note = rawNote.length > 0 ? rawNote : '';

      return {
        name,
        unit,
        qtyPerUnit,
        note,
        materialRole,
        fabricType,
        densityGsm,
        plannedWidthCm,
        colorRule,
        fixedColorText,
        hardwareSizeText,
        hardwareMaterialText,
        materialImageUrl,
        materialImageOriginalFileName,
      };
    })
    .filter((r): r is RawMaterialLineInput => r !== null);
}

function buildOutsourceLines(
  form: FormData,
): Array<Partial<TechCardOutsourceLineInputDto> & { name?: string }> {
  return parseLines(form, 'outsource')
    .map((r) => {
      // MVP-2 (ADR-0022 §«Cut-ready readiness»): подтянем выбранный
      // триггер из формы. Любое неожиданное значение сваливаем в
      // безопасный дефолт `MANUAL` — Zod на backend всё равно
      // проверит финальный enum.
      const rawTrigger = (r.triggerType ?? '').trim();
      const triggerType: OutsourceTriggerType =
        rawTrigger === 'CUT_READY' ? 'CUT_READY' : 'MANUAL';
      return {
        name: r.name ?? '',
        unit: r.unit ?? '',
        qtyPerUnit: r.qtyPerUnit ?? '',
        vendorName: r.vendorName ?? '',
        note: r.note ?? '',
        triggerType,
      };
    })
    .filter(
      (r) =>
        r.name.length > 0 ||
        r.unit.length > 0 ||
        r.qtyPerUnit.length > 0 ||
        r.vendorName.length > 0 ||
        r.note.length > 0,
    );
}

// ---------------------------------------------------------------------------
// «Подтянуть из номенклатуры» (см. ТЗ §1, §2)
// ---------------------------------------------------------------------------

/**
 * Тип источника шаблона строки техкарты — понадобился, когда мы
 * расширили action: теперь подтягиваем не только «Фурнитура и нормы»
 * (`PatternItemParameterNorm`), но и «Погонные метры по размерам»
 * (`PatternItemSizeParameterValue` с `inputTypeSnapshot ===
 * 'LINEAR_M_BY_SIZE'`). См. ТЗ §1, §2.
 *
 * Различение нужно для аудита и для возможных будущих UI-подсказок
 * (например, иконка/тег рядом со строкой). Действующий UI пока на
 * это поле не смотрит — dedupe идёт по `materialRole + fabricType`.
 */
export type PulledMaterialLineSourceType =
  | 'PARAMETER_NORM'
  | 'SIZE_PARAMETER_VALUE';

/**
 * Один «шаблон строки материала», подтянутый из конкретной номенклатуры
 * (PatternItem). Унифицированный контракт для обоих источников:
 *
 *   - `PARAMETER_NORM`        — `PatternItemParameterNorm` с
 *     `qtyPerItem > 0` (блок «Фурнитура и нормы»);
 *   - `SIZE_PARAMETER_VALUE`  — `PatternItemSizeParameterValue` с
 *     `inputTypeSnapshot === 'LINEAR_M_BY_SIZE'` и хотя бы одним
 *     значением `value > 0` по любому размеру (блок «Погонные метры»).
 *
 * Сами числовые значения нормы / погонных метров В ТЕХКАРТУ НЕ
 * ПЕРЕНОСЯТСЯ — они хранятся в номенклатуре и используются для
 * расчёта потребности (`WorkshopNeed`). В техкарте нужна только сама
 * строка материала: какая роль, как называется характеристика
 * полотна / фурнитуры, плотность, ширина, правило цвета, изображение
 * (см. ТЗ §1 «В техкарте не нужно переносить сами значения 1.2 / 1 /
 * 0.2»).
 */
export interface PulledMaterialLineTemplate {
  /** Snapshot `PatternCategoryParameter.roleKey` (например, PACKAGING / MAIN_FABRIC). */
  roleKey: string;
  /**
   * Snapshot `PatternCategoryParameter.label` (например, «Молния»
   * или «Основное полотно»). Идёт в `fabricType` строки техкарты.
   */
  labelSnapshot: string;
  /**
   * Единица измерения параметра. Для PARAMETER_NORM по умолчанию «шт»,
   * для SIZE_PARAMETER_VALUE по умолчанию «м пог.». Хранится в
   * snapshot-поле параметра (`PatternItemParameterNorm.unit` /
   * `PatternItemSizeParameterValue.unit`).
   */
  unit: string;
  /** Тип источника, см. {@link PulledMaterialLineSourceType}. */
  sourceType: PulledMaterialLineSourceType;
  /**
   * Идентификатор источника — для трассировки/аудита и для возможной
   * будущей идемпотентности:
   *   - PARAMETER_NORM         → `PatternItemParameterNorm.id`;
   *   - SIZE_PARAMETER_VALUE   → `PatternCategoryParameter.id`
   *     (значений несколько по разным размерам — мы их группируем в
   *     одну строку шаблона, см. ТЗ §«3 SIZE_PARAMETER_VALUE
   *     группировка по categoryParameterId»).
   */
  sourceId: string;
}

/**
 * Возвращает шаблоны строк техкарты по конкретной номенклатуре
 * (PatternItem). Используется кнопкой «Подтянуть из номенклатуры» в
 * `tech-card-form.tsx`.
 *
 * Поведение (см. ТЗ §1, §2):
 *
 *   1. Грузим `PatternDetailDto` через `getPattern(patternItemId)`.
 *   2. Источник A — «Фурнитура и нормы» (`PatternItemParameterNorm`):
 *      берём только нормы с `qtyPerItem > 0`. Параметры без нормы
 *      (Кнопки / Искусственный пух из примера ТЗ) НЕ подтягиваются.
 *   3. Источник B — «Погонные метры» (`PatternItemSizeParameterValue`):
 *      фильтруем строки с `inputTypeSnapshot === 'LINEAR_M_BY_SIZE'`,
 *      затем группируем по `categoryParameterId` и оставляем только
 *      группы, в которых есть хотя бы одно значение `value > 0` —
 *      ровно одна шаблонная строка на параметр, не строка-на-размер
 *      (см. ТЗ §«2 Источник B» + сценарий 3 в §8).
 *   4. Возвращаем единый массив шаблонов.
 *
 * Что НЕ возвращается:
 *   - `AREA_M2_BY_SIZE` (см. ТЗ §6 «На этом этапе не тянуть площади»);
 *   - `TEXT_ONLY` и любые прочие inputType — они не описывают
 *     материальные требования, попадают в техкарту вручную.
 *
 * НЕ дублирует и НЕ обновляет уже существующие строки в техкарте —
 * это решает клиентский код в
 * `tech-card-form.tsx::handlePullFromNomenclature` (по ключу
 * `materialRole + normalized fabricType`, см. ТЗ §3).
 */
export async function pullMaterialLinesFromPatternAction(
  patternItemId: string,
): Promise<
  | { ok: true; lines: PulledMaterialLineTemplate[]; patternName: string }
  | { ok: false; error: string }
> {
  const id = String(patternItemId ?? '').trim();
  if (id.length === 0) {
    return { ok: false, error: 'Не выбрана номенклатура' };
  }
  try {
    const pattern = await getPattern(id);
    const lines: PulledMaterialLineTemplate[] = [];

    // ─── Источник A: PatternItemParameterNorm (фурнитура и нормы) ─────
    //
    // ТЗ §1: фильтр строго `qtyPerItem > 0`. `Decimal` приходит строкой,
    // поэтому сравниваем через `Number(...)` — для значений вида
    // `'0.0000'` это даст 0 и норма отсеется. Доп. защита от значений
    // с пробелами / нечисловыми хвостами тут не нужна, backend уже
    // валидировал положительность при сохранении нормы.
    for (const norm of pattern.parameterNorms) {
      const numeric = Number(norm.qtyPerItem);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      lines.push({
        roleKey: norm.roleKey,
        labelSnapshot: norm.labelSnapshot,
        unit: norm.unit,
        sourceType: 'PARAMETER_NORM',
        sourceId: norm.id,
      });
    }

    // ─── Источник B: PatternItemSizeParameterValue (погонные метры) ───
    //
    // ТЗ §1, §2: тянем параметры с `inputTypeSnapshot ===
    // 'LINEAR_M_BY_SIZE'` и хотя бы одним значением `value > 0` по
    // любому активному размеру. Группируем по `categoryParameterId` —
    // в техкарту попадает ОДНА строка на параметр, а не строка на
    // каждый размер (см. сценарий 3 в §8).
    //
    // Сами числа `1.2 / 1 / 0.2` мы НЕ переносим: они уже хранятся в
    // номенклатуре и используются `WorkshopNeed`-ом. В техкарту едет
    // только описание материала (роль / характеристика полотна /
    // плотность / ширина / правило цвета / изображение).
    const linearGroups = new Map<
      string,
      {
        roleKey: string;
        labelSnapshot: string;
        unit: string;
        hasNonZero: boolean;
      }
    >();
    for (const v of pattern.sizeParameterValues) {
      if (v.inputTypeSnapshot !== 'LINEAR_M_BY_SIZE') continue;
      const numeric = Number(v.value);
      const isNonZero = Number.isFinite(numeric) && numeric > 0;
      const existing = linearGroups.get(v.categoryParameterId);
      if (existing) {
        if (isNonZero) existing.hasNonZero = true;
        continue;
      }
      linearGroups.set(v.categoryParameterId, {
        roleKey: v.roleKey,
        labelSnapshot: v.labelSnapshot,
        unit: v.unit,
        hasNonZero: isNonZero,
      });
    }
    for (const [categoryParameterId, group] of linearGroups) {
      if (!group.hasNonZero) continue;
      lines.push({
        roleKey: group.roleKey,
        labelSnapshot: group.labelSnapshot,
        unit: group.unit,
        sourceType: 'SIZE_PARAMETER_VALUE',
        sourceId: categoryParameterId,
      });
    }

    return { ok: true, lines, patternName: pattern.name };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: `Не удалось загрузить номенклатуру: ${e.message}`,
      };
    }
    return { ok: false, error: 'Не удалось загрузить номенклатуру' };
  }
}

/**
 * Возвращает шаблоны строк техкарты по группе номенклатур
 * (`PatternCategory`). Используется кнопкой «Подтянуть из группы»
 * в `tech-card-form.tsx` — менеджер выбирает группу, и в материальные
 * требования техкарты подтягиваются заготовки строк по всем «активным»
 * параметрам группы, описывающим материал.
 *
 * Источник — `PatternCategory.parameters` (а НЕ обход по дочерним
 * номенклатурам). Фильтры:
 *   - `status === 'ACTIVE'` — архивные параметры пропускаются;
 *   - `inputType ∈ { QTY_PER_ITEM, LINEAR_M_BY_SIZE }` — это параметры,
 *     описывающие материал (фурнитура на изделие и погонные метры);
 *   - `AREA_M2_BY_SIZE` и `TEXT_ONLY` пропускаются: площади в техкарту
 *     не идут (см. ТЗ §6), а TEXT_ONLY не описывает материал.
 *
 * Сами числовые значения в категории не хранятся — поэтому в техкарте
 * UI поставит «1» как sentinel в `qtyPerUnit` (см.
 * `handlePullFromCategory`).
 */
export async function pullMaterialLinesFromCategoryAction(
  categoryId: string,
): Promise<
  | { ok: true; lines: PulledMaterialLineTemplate[]; categoryName: string }
  | { ok: false; error: string }
> {
  const id = String(categoryId ?? '').trim();
  if (id.length === 0) {
    return { ok: false, error: 'Не выбрана группа номенклатур' };
  }
  try {
    const category = await getPatternCategory(id);
    const lines: PulledMaterialLineTemplate[] = [];
    const params = Array.isArray(category.parameters) ? category.parameters : [];
    for (const p of params) {
      if (p.status !== 'ACTIVE') continue;
      const inputType = p.inputType;
      let sourceType: PulledMaterialLineSourceType | null = null;
      if (inputType === 'QTY_PER_ITEM') sourceType = 'PARAMETER_NORM';
      else if (inputType === 'LINEAR_M_BY_SIZE') sourceType = 'SIZE_PARAMETER_VALUE';
      if (sourceType === null) continue;
      lines.push({
        roleKey: p.roleKey,
        labelSnapshot: p.label,
        unit: p.unit,
        sourceType,
        sourceId: p.id,
      });
    }
    return { ok: true, lines, categoryName: category.name };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: `Не удалось загрузить группу: ${e.message}`,
      };
    }
    return { ok: false, error: 'Не удалось загрузить группу' };
  }
}

function explainApiError(e: unknown, fallback: string): TechCardFormState {
  if (e instanceof ApiRequestError) {
    return {
      error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
      errorRequestId: e.requestId,
    };
  }
  return { error: fallback };
}

export async function createTechCardAction(
  _prev: TechCardFormState,
  form: FormData,
): Promise<TechCardFormState> {
  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const isActive = form.get('isActive') !== 'off';

  if (code.length === 0) return { error: 'Код техкарты обязателен' };
  if (!TECH_CARD_CODE_PATTERN.test(code)) {
    return {
      error:
        'Код техкарты: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
    };
  }
  if (name.length === 0) return { error: 'Название техкарты обязательно' };

  const parsed = CreateTechCardSchema.safeParse({
    code,
    name,
    isActive,
    materialLines: buildMaterialLines(form),
    outsourceLines: buildOutsourceLines(form),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные техкарты',
    };
  }

  let createdId: string | null = null;
  try {
    const created = await createTechCard(parsed.data);
    createdId = created.id;
    revalidatePath('/admin/tech-cards');
    revalidatePath('/orders/new');
  } catch (e) {
    return explainApiError(e, 'Не удалось создать техкарту');
  }
  if (createdId) {
    redirect(`/admin/tech-cards/${createdId}`);
  }
  return { ok: true, successMessage: 'Техкарта создана' };
}

// ---------------------------------------------------------------------------
// Загрузка изображения материала (см. ТЗ §5)
// ---------------------------------------------------------------------------
//
// Тип `UploadMaterialImageState` и значение `initialUploadMaterialImageState`
// объявлены в `./form-state.ts`. Это сознательный split: файл с
// `'use server'` обязан экспортировать только async-функции, иначе
// non-async export подменяется на server-reference и ломает рендер
// формы (`/admin/tech-cards/new` падал в 500 именно из-за этого —
// `useFormState(action, ИНИТ)` получал «функцию-плейсхолдер» вместо
// объекта-инициализатора).

/**
 * Загружает JPG/JPEG/PNG-изображение строки материала техкарты
 * (`POST /api/tech-cards/:techCardId/material-lines/:lineId/image`).
 *
 * Доступна ТОЛЬКО для уже сохранённой строки (есть `lineId`). Для
 * только-что добавленных строк UI показывает подсказку «Сохраните
 * техкарту, чтобы загрузить изображение» и не отрисовывает file
 * input. См. ТЗ §5 «Изображение прикрепляется файлом JPG/PNG».
 *
 * Backend сам валидирует расширение (`jpg`/`jpeg`/`png`) и размер;
 * здесь только форвардим `FormData`.
 */
export async function uploadMaterialImageAction(
  techCardId: string,
  lineId: string,
  _prev: UploadMaterialImageState,
  form: FormData,
): Promise<UploadMaterialImageState> {
  const techId = String(techCardId ?? '').trim();
  const ln = String(lineId ?? '').trim();
  if (techId.length === 0 || ln.length === 0) {
    return { error: 'Не указаны id техкарты или строки материала' };
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Выберите JPG/PNG файл изображения' };
  }
  const lower = file.name.toLowerCase();
  // Дублируем фильтр расширения здесь, чтобы дать пользователю
  // мгновенный feedback без round-trip на API. Backend всё равно
  // финально валидирует.
  if (
    !(
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.png')
    )
  ) {
    return { error: 'Допустимы только JPG/JPEG/PNG' };
  }
  try {
    const updated = await uploadTechCardMaterialLineImage(techId, ln, file);
    revalidatePath(`/admin/tech-cards/${techId}`);
    revalidatePath('/admin/tech-cards');
    return {
      ok: true,
      successMessage: 'Изображение загружено',
      template: updated,
    };
  } catch (e) {
    return explainApiError(e, 'Не удалось загрузить изображение');
  }
}

export async function updateTechCardAction(
  _prev: TechCardFormState,
  form: FormData,
): Promise<TechCardFormState> {
  const id = String(form.get('id') ?? '').trim();
  if (id.length === 0) return { error: 'Не указан id техкарты' };

  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const isActive = form.get('isActive') !== 'off';

  if (code.length === 0) return { error: 'Код техкарты обязателен' };
  if (!TECH_CARD_CODE_PATTERN.test(code)) {
    return {
      error:
        'Код техкарты: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
    };
  }
  if (name.length === 0) return { error: 'Название техкарты обязательно' };

  const parsed = UpdateTechCardSchema.safeParse({
    code,
    name,
    isActive,
    materialLines: buildMaterialLines(form),
    outsourceLines: buildOutsourceLines(form),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные техкарты',
    };
  }

  try {
    await updateTechCard(id, parsed.data);
    revalidatePath('/admin/tech-cards');
    revalidatePath(`/admin/tech-cards/${id}`);
    revalidatePath('/orders/new');
  } catch (e) {
    return explainApiError(e, 'Не удалось обновить техкарту');
  }
  return { ok: true, successMessage: 'Техкарта обновлена' };
}

/**
 * Soft-delete техкарты — деактивация (`isActive = false`) через
 * существующий `PATCH /api/tech-cards/:id`. Hard-delete у техкарт
 * намеренно не выставлен (см. JSDoc `TechCardsController`): карта может
 * быть зашита в snapshot заказов (`OrderMaterialRequirement` /
 * `OrderOutsourceRequirement` ссылаются на её строки), поэтому строку
 * из БД не удаляем — она просто уходит из активного справочника
 * (`/orders/new` подгружает только `isActive: true`).
 *
 * Без `redirect`: action вызывается из client-кнопки через
 * `useTransition` (`archive-tech-card-button.tsx`), а `redirect()`
 * бросил бы `NEXT_REDIRECT` прямо в её `catch`. После `revalidatePath`
 * карточка перерисуется со статусом «Неактивна». Ошибку пробрасываем
 * `Error`-ом — кнопка покажет её inline.
 */
export async function archiveTechCardAction(id: string): Promise<void> {
  try {
    await updateTechCard(id, { isActive: false });
  } catch (e) {
    const msg =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось архивировать техкарту';
    throw new Error(msg);
  }
  revalidatePath('/admin/tech-cards');
  revalidatePath(`/admin/tech-cards/${id}`);
  revalidatePath('/orders/new');
}

/**
 * Hard-delete архивной (неактивной) техкарты
 * (`DELETE /api/tech-cards/:id/permanent`). Зовётся из кнопки «Удалить
 * навсегда» на карточке (видна только для `isActive = false`). Backend
 * блокирует удаление, если карта используется в заказах/snapshot
 * (409 `TECH_CARD_DELETE_FORBIDDEN`) — пробрасываем текст `Error`-ом.
 *
 * Без `redirect`: карточки техкарты после удаления нет, навигацию на
 * список делает client-кнопка (`router.push`) после успешного `await`.
 */
export async function deleteTechCardPermanentAction(
  id: string,
): Promise<void> {
  try {
    await deleteTechCard(id);
  } catch (e) {
    // Только человекочитаемый текст из 409 (без технического кода) —
    // backend сам объясняет «почему нельзя и как удалить правильно».
    throw new Error(
      e instanceof ApiRequestError
        ? e.message
        : 'Не удалось удалить техкарту. Попробуйте обновить страницу и повторить.',
    );
  }
  revalidatePath('/admin/tech-cards');
  revalidatePath('/orders/new');
}
