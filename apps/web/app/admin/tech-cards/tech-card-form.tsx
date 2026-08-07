'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useRef, useState, useTransition } from 'react';
import { Check, ImageIcon, Plus, Save, Trash2, Upload } from 'lucide-react';
import {
  TECH_CARD_PARAMETER_INPUT_TYPES,
  TECH_CARD_PARAMETER_INPUT_TYPE_LABELS,
  TECH_CARD_PARAMETER_TARGETS,
} from '@sewing/shared/tech-card-parameters';
import type {
  OutsourceTriggerType,
  TechCardMaterialColorRule,
  TechCardTemplateDetailDto,
} from '@sewing/shared/tech-cards';
import {
  TECH_CARD_MATERIAL_COLOR_RULES,
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  TECH_CARD_MATERIAL_ROLE_KEYS,
  getTechCardMaterialRoleLabel,
  isKnownTechCardMaterialRoleKey,
} from '@sewing/shared/tech-cards';
import {
  getMaterialCharacteristic,
  getMaterialSubtype,
  resolveRequiredCharacteristicKeys,
} from '@sewing/shared/material-characteristics';
import {
  characteristicValueFromSubtypeKey,
  resolveSubtypeKeyByCharacteristic,
} from '@sewing/shared/material-characteristic-options';
import { CharacteristicCombobox } from '@/components/materials/characteristic-combobox';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import {
  createTechCardAction,
  pullMaterialLinesFromCategoryAction,
  pullMaterialLinesFromPatternAction,
  updateTechCardAction,
  uploadMaterialImageAction,
} from './actions';
import {
  initialTechCardFormState,
  initialUploadMaterialImageState,
  type TechCardFormState,
  type UploadMaterialImageState,
} from './form-state';
import { CODE_PATTERN, CODE_PATTERN_TITLE } from '@/lib/code-pattern';

type Mode = 'create' | 'edit';

/**
 * Лёгкое представление номенклатуры (PatternItem) для select-а
 * «Подтянуть из номенклатуры». RSC-страница (new/[id]) подтягивает
 * список через `listPatterns({ status: 'ACTIVE' })` и прокидывает сюда.
 * Шаблоны строк тянутся уже из server action
 * `pullMaterialLinesFromPatternAction(patternItemId)` по конкретной
 * выбранной номенклатуре — оттуда берутся только реально используемые
 * параметры через `PatternItemParameterNorm.qtyPerItem > 0`
 * (см. ТЗ §1, §5).
 */
export interface PatternItemOption {
  id: string;
  name: string;
  /** Артикул — показываем рядом с названием для disambiguation. */
  article: string;
}

/**
 * Лёгкое представление группы номенклатур (`PatternCategory`) для
 * select-а «Подтянуть из группы». RSC-страница (new/[id]) подтягивает
 * список через `listPatternCategories({ status: 'ACTIVE' })` и
 * прокидывает сюда только plain `{ id, name }`.
 */
export interface PatternCategoryOption {
  id: string;
  name: string;
}

interface Props {
  mode: Mode;
  /** Только в режиме `edit` — текущее состояние техкарты. */
  template?: TechCardTemplateDetailDto;
  /**
   * Активные номенклатуры (PatternItem) — id + name + article. Используются
   * select-ом «Подтянуть из номенклатуры». Пустой список допустим —
   * кнопка просто не появится. Источник истины — `listPatterns({
   * status: 'ACTIVE' })`. См. ТЗ §1: тянем из конкретной номенклатуры,
   * а не из категории.
   */
  patternItems?: PatternItemOption[];
  /**
   * Активные группы номенклатур (`PatternCategory`). Используются
   * select-ом «Подтянуть из группы» во второй колонке блока
   * «Материальные требования». Пустой список допустим — колонка
   * просто покажет disabled-сообщение.
   */
  patternCategories?: PatternCategoryOption[];
}

interface MaterialRow {
  key: string;
  /**
   * id строки материала в БД (`TechCardMaterialLine.id`) — заполнен
   * только для строк, пришедших из существующего шаблона (`template`)
   * в режиме `edit`. Для новых, ещё не сохранённых строк остаётся
   * `null` — UI по этому полю решает, можно ли уже сейчас грузить
   * изображение материала (см. ТЗ §5: «Для новых несохранённых строк
   * показать подсказку: Сохраните техкарту, чтобы загрузить
   * изображение»). Хранится только в client-state, в backend не
   * передаётся (full-replace при PATCH создаёт новые id).
   */
  existingLineId: string | null;
  // Legacy поля (`name`, `unit`, `qtyPerUnit`, `note`) скрыты от
  // пользователя в UI, но сохраняются в state для backward-compat:
  // если строка пришла со старой техкарты со значениями, мы их не
  // теряем — они уходят в hidden input при submit. Если же строка
  // создана в новом UI и legacy-полей нет, action в `actions.ts`
  // сгенерирует безопасный fallback (`fabricType`/role label, `кг`,
  // `1`, пустая заметка).
  name: string;
  unit: string;
  qtyPerUnit: string;
  note: string;
  // Этап «Техкарта = материальные требования»: видимые поля строки.
  // Хранятся строкой в state-е формы, чтобы число можно было «затереть»
  // в null при сохранении (см. `actions.ts::buildMaterialLines`).
  // `materialRole` — свободная строка (см. ТЗ §1, источник ролей —
  // `PATTERN_CATEGORY_PARAMETER_GROUPS`); legacy roleKey-и (например
  // `APPLICATION` со старых техкарт) сохраняются в state как есть и
  // отрисовываются как read-only `(legacy)` опция.
  materialRole: string;
  // Фаза 2 «Характеристики номенклатуры»: ключ подтипа (Молния,
  // Кашкорсе, Дублерин, ...; whitelist — `MATERIAL_SUBTYPES`) и
  // значения «новых» характеристик без legacy-колонки (type/length/
  // thickness/holesCount/width). Legacy-характеристики (плотность/
  // ширина рулона/размер/материал) остаются в dedicated-полях ниже.
  subtypeKey: string;
  characteristics: Record<string, string>;
  fabricType: string;
  densityGsm: string;
  plannedWidthCm: string;
  colorRule: '' | TechCardMaterialColorRule;
  fixedColorText: string;
  // Этап «Фурнитура в техкарте» (см. ТЗ §3): видимы только при
  // `materialRole === 'PACKAGING'` (UI-метка «Фурнитура»). Backend
  // зачищает hardware* в null для других ролей.
  hardwareSizeText: string;
  hardwareMaterialText: string;
  // Этап «Изображение материала» (см. ТЗ §5): URL картинки + опц.
  // имя файла (пока без upload-эндпоинта, см. ТЗ §5 «MVP — URL»).
  materialImageUrl: string;
  materialImageOriginalFileName: string;
}

interface OutsourceRow {
  key: string;
  name: string;
  unit: string;
  qtyPerUnit: string;
  vendorName: string;
  note: string;
  triggerType: OutsourceTriggerType;
}

// Характеристики с legacy-колонкой рендерятся отдельными полями
// (плотность/ширина рулона/размер/материал) — их НЕ дублируем в
// динамическом блоке характеристик подтипа.
const LEGACY_CHARACTERISTIC_KEYS = ['density', 'rollWidth', 'size', 'material'];

let __rowKeySeq = 0;
function nextKey(): string {
  __rowKeySeq += 1;
  return `r${Date.now().toString(36)}_${__rowKeySeq}`;
}

/** Стабильный ключ строки материала, пришедшей из БД (см. init `materials`). */
function lineRowKey(lineId: string): string {
  return `line_${lineId}`;
}

/**
 * Слот техкарты в форме. `paramKey` — стабильный технический ключ: на него
 * ссылаются привязки ячеек и значения в заказах, поэтому при переименовании
 * лейбла он НЕ меняется.
 */
interface ParameterRow {
  key: string;
  paramKey: string;
  label: string;
  inputType: string;
  /** Для ENUM: значения через запятую («160, 190, 220»). */
  options: string;
  unit: string;
  isRequired: boolean;
  defaultValue: string;
  /** Ключ строки материала, в ячейку которой подставляется значение. */
  targetRowKey: string;
  /** Ячейка этой строки (`char:density`, `core:qtyPerUnit`, ...). */
  targetField: string;
}

let __paramKeySeq = 0;
/** Технический ключ нового слота: пользователю не показывается. */
function nextParamKey(existing: ParameterRow[]): string {
  __paramKeySeq += 1;
  let candidate = `param_${existing.length + __paramKeySeq}`;
  const taken = new Set(existing.map((p) => p.paramKey));
  while (taken.has(candidate)) {
    __paramKeySeq += 1;
    candidate = `param_${existing.length + __paramKeySeq}`;
  }
  return candidate;
}

function emptyMaterialRow(seed: Partial<MaterialRow> = {}): MaterialRow {
  return {
    key: nextKey(),
    existingLineId: null,
    name: '',
    unit: '',
    qtyPerUnit: '',
    note: '',
    materialRole: '',
    subtypeKey: '',
    characteristics: {},
    fabricType: '',
    densityGsm: '',
    plannedWidthCm: '',
    colorRule: '',
    fixedColorText: '',
    hardwareSizeText: '',
    hardwareMaterialText: '',
    materialImageUrl: '',
    materialImageOriginalFileName: '',
    ...seed,
  };
}

/**
 * Нормализует `fabricType` к ключу для dedupe (см. ТЗ §3): trim +
 * lowercase + единичные пробелы. Это позволяет считать «Молния» и
 * «  молния  » одной и той же позицией при подтягивании из
 * номенклатуры. Для пустого fabricType возвращаем пустую строку —
 * dedupe тогда работает только по `materialRole` (как раньше).
 */
function normalizeDedupeFabric(value: string | null | undefined): string {
  if (value == null) return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Ключ дедупликации строки материала (см. ТЗ §3). Для PACKAGING это
 * `PACKAGING + Молния`, `PACKAGING + Кнопки`, `PACKAGING + Люверсы` —
 * разные строки, их разрешено иметь несколько в одной техкарте. Для
 * остальных ролей пустой fabricType означает «нет уточнения», и
 * подтягивание не плодит дубликаты роли.
 */
function dedupeKey(roleKey: string, fabricType: string | null): string {
  return `${roleKey}::${normalizeDedupeFabric(fabricType)}`;
}

/**
 * Создаёт `MaterialRow` из шаблона `{ roleKey, labelSnapshot, unit }`.
 * Используется обоими pull-обработчиками — клик заменяет общий список
 * строк техкарты тем, что пришло из выбранной номенклатуры/группы.
 * Дефолтное правило цвета: для PACKAGING — «Указать в заказе», для
 * тканевых ролей — «Цвет заказа» (см. legacy-комментарий ниже в
 * handlePullFromNomenclature).
 */
function rowFromPulledLine(line: {
  roleKey: string;
  labelSnapshot: string;
  unit: string;
  qtyPerUnit?: string | null;
}): MaterialRow {
  const isPackaging = line.roleKey === 'PACKAGING';
  // Норма из номенклатуры, если она там есть. Раньше здесь стояла жёсткая
  // единица — и эта заглушка уезжала в заказ: менеджер видел «норма 1», а
  // закупка считалась по номенклатуре. Числа нет (подтягивание из ГРУППЫ,
  // где только определения параметров) — остаётся «1» как безопасный
  // sentinel: `TechCardMaterialLineInputSchema` требует число > 0.
  const pulled = (line.qtyPerUnit ?? '').trim();
  const numeric = Number(pulled);
  return emptyMaterialRow({
    materialRole: line.roleKey,
    fabricType: line.labelSnapshot,
    // Подтип выводим из подтянутого названия по тому же правилу, что и
    // при ручном вводе: пришёл параметр «Молния» — строка сразу получает
    // подтип со своими доп. полями, а не пустоту, которую менеджер
    // раньше добирал руками через убранное поле «Подтип».
    subtypeKey:
      resolveSubtypeKeyByCharacteristic(line.roleKey, line.labelSnapshot) ?? '',
    unit: line.unit,
    qtyPerUnit:
      pulled !== '' && Number.isFinite(numeric) && numeric > 0 ? pulled : '1',
    colorRule: isPackaging ? 'ORDER_SELECTED_COLOR' : 'ORDER_COLOR',
  });
}

const OUTSOURCE_TRIGGER_LABELS: Record<OutsourceTriggerType, string> = {
  MANUAL: 'Вручную',
  CUT_READY: 'Когда крой размещён в ячейки',
};

const MATERIAL_REQUIREMENTS_HINT =
  'Техкарта определяет требования к материалам. Нанесение задаётся в заказе, упаковка — в операциях маршрута.';

/**
 * Текст-подсказка рядом с кнопкой «Подтянуть из номенклатуры»
 * (см. ТЗ §4). Описывает обоих источников:
 *   - «Фурнитура и нормы» (`PatternItemParameterNorm.qtyPerItem > 0`);
 *   - «Погонные метры» (`PatternItemSizeParameterValue` LINEAR_M_BY_SIZE
 *     с хотя бы одним value > 0).
 *
 * Текст сознательно избегает технических имён моделей — менеджер
 * читает «нормы фурнитуры» и «параметры погонных метров»
 * (так же названы блоки в карточке номенклатуры).
 */
const PULL_FROM_NOMENCLATURE_HINT =
  'Подтягивает из выбранной номенклатуры заполненные нормы фурнитуры и заполненные параметры погонных метров ВМЕСТЕ С ЧИСЛАМИ. Пустые параметры не добавляются.';

/**
 * Сообщение, когда action отработал, но в номенклатуре по обоим
 * блокам нет данных (см. ТЗ §4). Текст совпадает по формулировке с
 * подсказкой выше — менеджер сразу видит, что именно не заполнено.
 */
const PULL_FROM_NOMENCLATURE_EMPTY =
  'В номенклатуре нет заполненных норм или погонных метров. Нечего подтягивать.';

/**
 * Текст-подсказка рядом с кнопкой «Подтянуть из группы». Группа
 * описывает только определения параметров (без числовых значений),
 * поэтому в техкарту едут заготовки строк для каждого активного
 * параметра с inputType ∈ { QTY_PER_ITEM, LINEAR_M_BY_SIZE }.
 * Площади (AREA_M2_BY_SIZE) и текстовые услуги (TEXT_ONLY) НЕ
 * подтягиваются.
 */
const PULL_FROM_CATEGORY_HINT =
  'Подтягивает строки материалов из всех активных параметров группы: фурнитура на изделие и погонные метры. Площади и текстовые параметры не подтягиваются.';

const PULL_FROM_CATEGORY_EMPTY =
  'В группе нет параметров для подтягивания (фурнитуры на изделие или погонных метров).';

const OUTSOURCE_LEGACY_HINT =
  'Старые внешние услуги сохранены как legacy. Новые нанесения задаются в заказе покупателя.';

function SubmitButton({ mode }: { mode: Mode }) {
  const { pending } = useFormStatus();
  const Icon = mode === 'create' ? Plus : Save;
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Icon size={16} strokeWidth={1.6} aria-hidden />
      {pending
        ? 'Сохраняем…'
        : mode === 'create'
        ? 'Создать техкарту'
        : 'Сохранить изменения'}
    </button>
  );
}

/**
 * Универсальная форма техкарты (`/admin/tech-cards/new` и
 * `/admin/tech-cards/[id]`).
 *
 * Этап «Техкарта = материальные требования» (UI/compatibility refactor):
 *   - блок переименован в «Материальные требования»;
 *   - legacy поля строки (`name`, `unit`, `qtyPerUnit`, `note`)
 *     скрыты от пользователя — они едут как `hidden input`-ы и
 *     генерируются автоматически в `actions.ts::buildMaterialLines`
 *     (`fabricType` / role label → name, `кг` → unit, `1` →
 *     qtyPerUnit-fallback, пустая заметка);
 *   - в select «Роль материала» больше не предлагаются
 *     `APPLICATION` и `PACKAGING` (нанесение и упаковка теперь
 *     живут вне техкарты — в заказе и маршруте соответственно);
 *   - блок «Внешние потребности» сохранён только для legacy-данных
 *     (read-only-ish: без кнопки «Добавить», с пояснением, что
 *     новые нанесения задаются в заказе покупателя).
 *
 * Backend / Prisma / shared schema не меняются — это чисто UI и
 * compatibility-слой в server actions.
 */
export function TechCardForm({
  mode,
  template,
  patternItems,
  patternCategories,
}: Props) {
  // Защита от прода: prop `patternItems` ОБЯЗАН быть массивом, иначе
  // дальше `.map`/`.length` уронит весь рендер формы (и страницу
  // `/admin/tech-cards/new` в 500). Дефолт `= []` в сигнатуре
  // срабатывает только когда prop вовсе не передан, а не когда
  // прокинут `undefined`/не-массив. Нормализуем явно.
  const safePatternItems: PatternItemOption[] = Array.isArray(patternItems)
    ? patternItems
    : [];
  const safePatternCategories: PatternCategoryOption[] = Array.isArray(
    patternCategories,
  )
    ? patternCategories
    : [];
  // Идентификатор техкарты в режиме edit — нужен для upload-эндпоинта
  // изображения строки материала (см. ТЗ §5). В режиме `create`
  // techCardId ещё нет, и для всех строк показываем подсказку
  // «Сохраните техкарту, чтобы загрузить изображение».
  const techCardId = mode === 'edit' && template ? template.id : null;
  const [materials, setMaterials] = useState<MaterialRow[]>(() => {
    if (mode !== 'edit' || !template) return [];
    // Защита от prod: если backend по какой-то причине вернёт DTO без
    // `materialLines` (или не-массивом), не падать .map-ом — рендерим
    // пустой список, менеджер просто увидит «Пока пусто». На корректных
    // ответах поведение прежнее.
    const lines = Array.isArray(template.materialLines)
      ? template.materialLines
      : [];
    return lines.map((l) => ({
      // Детерминированный ключ (а не nextKey()): на него ссылается параметр,
      // и без стабильности привязка «ячейка → параметр» не восстановилась бы
      // при открытии формы.
      key: lineRowKey(l.id),
      existingLineId: l.id,
      name: l.name,
      unit: l.unit,
      qtyPerUnit: l.qtyPerUnit,
      note: l.note ?? '',
      materialRole: l.materialRole ?? '',
      subtypeKey: l.subtypeKey ?? '',
      // В state-е строки держим только «новые» характеристики (без
      // legacy-колонки) — legacy лежат в densityGsm/plannedWidthCm/
      // hardware*. Значения приводим к строке для контролируемых input-ов.
      characteristics: Object.fromEntries(
        Object.entries(l.characteristics ?? {})
          .filter(([k]) => !LEGACY_CHARACTERISTIC_KEYS.includes(k))
          .map(([k, v]) => [k, String(v)]),
      ),
      // Поле «Характеристика» (бывшая «Характеристика полотна»). У строк,
      // заполненных ДО отказа от поля «Подтип», значение лежит в
      // `subtypeKey`, а `fabricType` пуст — показываем лейбл подтипа,
      // чтобы старая техкарта открывалась заполненной, а не пустой.
      fabricType:
        (l.fabricType ?? '') ||
        characteristicValueFromSubtypeKey(l.subtypeKey),
      densityGsm: l.densityGsm == null ? '' : String(l.densityGsm),
      plannedWidthCm:
        l.plannedWidthCm == null ? '' : String(l.plannedWidthCm),
      colorRule: l.colorRule ?? '',
      fixedColorText: l.fixedColorText ?? '',
      hardwareSizeText: l.hardwareSizeText ?? '',
      hardwareMaterialText: l.hardwareMaterialText ?? '',
      materialImageUrl: l.materialImageUrl ?? '',
      materialImageOriginalFileName: l.materialImageOriginalFileName ?? '',
    }));
  });
  // «Подтянуть из номенклатуры» (см. ТЗ §1). State для select-а
  // конкретной номенклатуры (PatternItem) и pending-индикатора
  // server action-а; ошибки/сводку сохраняем отдельно, чтобы UI мог
  // подсветить рядом с кнопкой.
  const [pullPatternId, setPullPatternId] = useState<string>('');
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullSummary, setPullSummary] = useState<string | null>(null);
  const [isPulling, startPullTransition] = useTransition();
  // «Подтянуть из группы»: независимый state — собственный select,
  // pending-индикатор и сообщения. Деление по двум блокам нужно,
  // чтобы pending одной кнопки не блокировал и не подсвечивал ошибки
  // другой.
  const [pullCategoryId, setPullCategoryId] = useState<string>('');
  const [pullCategoryError, setPullCategoryError] = useState<string | null>(
    null,
  );
  const [pullCategorySummary, setPullCategorySummary] = useState<string | null>(
    null,
  );
  const [isPullingCategory, startPullCategoryTransition] = useTransition();
  const [outsource, setOutsource] = useState<OutsourceRow[]>(() => {
    if (mode !== 'edit' || !template) return [];
    const lines = Array.isArray(template.outsourceLines)
      ? template.outsourceLines
      : [];
    return lines.map((l) => ({
      key: nextKey(),
      name: l.name,
      unit: l.unit ?? '',
      qtyPerUnit: l.qtyPerUnit ?? '',
      vendorName: l.vendorName ?? '',
      note: l.note ?? '',
      triggerType: l.triggerType,
    }));
  });

  // Фича «Параметры техкарт»: слоты, значение которых вводится в заказе.
  // Ключ (`key`) — стабильный идентификатор слота: по нему значения в заказе
  // находят свой параметр, поэтому при переименовании лейбла он НЕ меняется.
  const [parameters, setParameters] = useState<ParameterRow[]>(() => {
    if (mode !== 'edit' || !template) return [];
    const list = Array.isArray(template.parameters) ? template.parameters : [];
    // Восстанавливаем, в какую ячейку какой строки смотрит параметр: в БД это
    // хранится на СТРОКЕ (`parameterBindings`), а в форме удобнее показывать
    // как свойство параметра.
    const lines = Array.isArray(template.materialLines)
      ? template.materialLines
      : [];
    return list.map((p) => {
      let targetRowKey = '';
      let targetField = '';
      for (const l of lines) {
        const found = Object.entries(l.parameterBindings ?? {}).find(
          ([, key]) => key === p.key,
        );
        if (found) {
          targetRowKey = lineRowKey(l.id);
          targetField = found[0];
          break;
        }
      }
      return {
        key: nextKey(),
        paramKey: p.key,
        label: p.label,
        inputType: p.inputType,
        options: (p.options ?? []).join(', '),
        unit: p.unit ?? '',
        isRequired: p.isRequired,
        defaultValue: p.defaultValue ?? '',
        targetRowKey,
        targetField,
      };
    });
  });

  const [createState, createAction] = useFormState<TechCardFormState, FormData>(
    createTechCardAction,
    initialTechCardFormState,
  );
  const [updateState, updateAction] = useFormState<TechCardFormState, FormData>(
    updateTechCardAction,
    initialTechCardFormState,
  );

  const formAction = mode === 'create' ? createAction : updateAction;
  const state = mode === 'create' ? createState : updateState;

  const updateMaterial = (
    key: string,
    patch: Partial<Omit<MaterialRow, 'key'>>,
  ) => {
    setMaterials((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  };
  const updateOutsource = (
    key: string,
    patch: Partial<Omit<OutsourceRow, 'key'>>,
  ) => {
    setOutsource((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  };

  /**
   * «Подтянуть из номенклатуры» — server action по выбранной номенклатуре
   * (`PatternItem`) возвращает шаблоны строк материалов из двух источников:
   *   - «Фурнитура и нормы» (`PatternItemParameterNorm.qtyPerItem > 0`);
   *   - «Погонные метры» (`PatternItemSizeParameterValue`
   *     `LINEAR_M_BY_SIZE` с хотя бы одним `value > 0`).
   *
   * Поведение: ПОЛНАЯ ЗАМЕНА списка строк материалов содержимым
   * выбранной номенклатуры. То есть если ранее подтянули номенклатуру
   * A и список наполнился её строками, а потом выбрали номенклатуру B —
   * список заменяется на строки B. Старые строки (в т.ч. вручную
   * заполненные) теряются: pull — это «снимок из источника», не merge.
   * Дедупликация ВНУТРИ нового списка по `materialRole + fabricType`
   * на случай, если источник вернёт два одинаковых параметра (фурнитура
   * группы PACKAGING с разным `fabricType` остаётся как несколько
   * строк — ключ их различает).
   *
   * Числа ПЕРЕНОСЯТСЯ: норма фурнитуры — как есть, погонные метры —
   * средним по заполненным размерам. Истина по норме остаётся у
   * номенклатуры: заказ выводит её заново по своему размерному плану
   * (`@sewing/shared/pattern-norms`), шаблон только сеет разумный старт.
   *
   * Работает и в режиме `create`, и в `edit`: никакого `techCardId` не
   * нужно — action ходит в номенклатуру по её id.
   */
  const handlePullFromNomenclature = () => {
    setPullError(null);
    setPullSummary(null);
    // Двойная защита: и кнопка `disabled={pullPatternId === ''}`, и
    // явный гард тут — server action никогда не должен вызываться с
    // пустым id (иначе на backend полетит `getPattern('')`).
    const trimmedId = pullPatternId.trim();
    if (trimmedId === '') {
      setPullError('Выберите номенклатуру');
      return;
    }
    startPullTransition(async () => {
      const result = await pullMaterialLinesFromPatternAction(trimmedId);
      if (!result.ok) {
        setPullError(result.error);
        return;
      }
      // Полная замена: если в источнике пусто — список тоже опустеет.
      // Это важная часть UX: менеджер должен видеть СОДЕРЖИМОЕ выбранной
      // номенклатуры, а не объединение с прошлой выборкой.
      if (result.lines.length === 0) {
        setMaterials([]);
        setPullSummary(PULL_FROM_NOMENCLATURE_EMPTY);
        return;
      }
      const seen = new Set<string>();
      const next: MaterialRow[] = [];
      for (const line of result.lines) {
        const k = dedupeKey(line.roleKey, line.labelSnapshot);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(rowFromPulledLine(line));
      }
      setMaterials(next);
      setPullSummary(`Подтянуто строк: ${next.length}. Список заменён.`);
    });
  };

  /**
   * «Подтянуть из группы» — server action
   * `pullMaterialLinesFromCategoryAction` возвращает шаблоны строк
   * по активным параметрам выбранной группы. Поведение и правила те
   * же, что у `handlePullFromNomenclature`: ПОЛНАЯ ЗАМЕНА общего
   * списка строк материалов содержимым выбранной группы.
   */
  const handlePullFromCategory = () => {
    setPullCategoryError(null);
    setPullCategorySummary(null);
    const trimmedId = pullCategoryId.trim();
    if (trimmedId === '') {
      setPullCategoryError('Выберите группу номенклатур');
      return;
    }
    startPullCategoryTransition(async () => {
      const result = await pullMaterialLinesFromCategoryAction(trimmedId);
      if (!result.ok) {
        setPullCategoryError(result.error);
        return;
      }
      if (result.lines.length === 0) {
        setMaterials([]);
        setPullCategorySummary(PULL_FROM_CATEGORY_EMPTY);
        return;
      }
      const seen = new Set<string>();
      const next: MaterialRow[] = [];
      for (const line of result.lines) {
        const k = dedupeKey(line.roleKey, line.labelSnapshot);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(rowFromPulledLine(line));
      }
      setMaterials(next);
      setPullCategorySummary(
        `Подтянуто строк: ${next.length}. Список заменён.`,
      );
    });
  };

  return (
    <form action={formAction} className="admin-form">
      {mode === 'edit' && template && (
        <input type="hidden" name="id" value={template.id} />
      )}

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="tc-code">Код</label>
          <input
            id="tc-code"
            name="code"
            type="text"
            maxLength={48}
            required
            autoComplete="off"
            defaultValue={template?.code ?? ''}
            placeholder="TSHIRT-BASIC"
            pattern={CODE_PATTERN}
            title={CODE_PATTERN_TITLE}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="tc-name">Название</label>
          <input
            id="tc-name"
            name="name"
            type="text"
            maxLength={120}
            required
            autoComplete="off"
            defaultValue={template?.name ?? ''}
            placeholder="Базовая футболка"
          />
        </div>
        <div className="admin-field admin-field--inline">
          <input
            id="tc-active"
            type="checkbox"
            name="isActive"
            value="on"
            defaultChecked={template?.isActive ?? true}
          />
          <label htmlFor="tc-active">Активна</label>
        </div>
      </div>

      <section className="admin-stack admin-tech-card-params">
        <div className="admin-actions-row admin-actions-row--split">
          <strong>Параметры техкарты</strong>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() =>
              setParameters((p) => [
                ...p,
                {
                  key: nextKey(),
                  paramKey: nextParamKey(p),
                  label: '',
                  inputType: 'TEXT',
                  options: '',
                  unit: '',
                  isRequired: true,
                  defaultValue: '',
                  targetRowKey: '',
                  targetField: '',
                },
              ])
            }
          >
            <Plus size={14} strokeWidth={1.6} aria-hidden />
            Добавить параметр
          </button>
        </div>
        <p className="admin-muted">
          Параметр — это ячейка строки материала, значение которой заполняется
          не здесь, а в заказе, по каждой расцветке отдельно. Один шаблон
          с параметром «Плотность» заменяет несколько почти одинаковых техкарт.
        </p>

        {parameters.length === 0 ? (
          <p className="admin-muted">
            Пока нет: все ячейки строк заданы жёстко.
          </p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table--compact">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Тип</th>
                  <th>Значения списка</th>
                  <th>Ед.</th>
                  <th>Подставляется в</th>
                  <th>Обяз.</th>
                  <th>По умолчанию</th>
                  <th aria-label="Действия" />
                </tr>
              </thead>
              <tbody>
                {parameters.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <input type="hidden" name={`parameter[${p.key}][key]`} value={p.paramKey} />
                      <input
                        type="text"
                        name={`parameter[${p.key}][label]`}
                        value={p.label}
                        maxLength={120}
                        placeholder="Плотность полотна"
                        onChange={(e) =>
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key ? { ...r, label: e.target.value } : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        name={`parameter[${p.key}][inputType]`}
                        value={p.inputType}
                        onChange={(e) =>
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, inputType: e.target.value }
                                : r,
                            ),
                          )
                        }
                      >
                        {TECH_CARD_PARAMETER_INPUT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {TECH_CARD_PARAMETER_INPUT_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`parameter[${p.key}][options]`}
                        value={p.options}
                        disabled={p.inputType !== 'ENUM'}
                        placeholder="160, 190, 220"
                        onChange={(e) =>
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key ? { ...r, options: e.target.value } : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`parameter[${p.key}][unit]`}
                        value={p.unit}
                        maxLength={20}
                        placeholder="г/м²"
                        onChange={(e) =>
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key ? { ...r, unit: e.target.value } : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      {/* Главное поле: без цели значение параметра некуда
                          подставить — он бы ни на что не влиял. */}
                      <select
                        name={`parameter[${p.key}][target]`}
                        value={
                          p.targetRowKey && p.targetField
                            ? `${p.targetRowKey}|${p.targetField}`
                            : ''
                        }
                        onChange={(e) => {
                          const [rowKey = '', field = ''] =
                            e.target.value.split('|');
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, targetRowKey: rowKey, targetField: field }
                                : r,
                            ),
                          );
                        }}
                      >
                        <option value="">— не подставляется —</option>
                        {materials.map((m) => (
                          <optgroup
                            key={m.key}
                            label={m.name || m.fabricType || 'Без названия'}
                          >
                            {TECH_CARD_PARAMETER_TARGETS.map((t) => (
                              <option
                                key={`${m.key}|${t.field}`}
                                value={`${m.key}|${t.field}`}
                              >
                                {t.label}
                                {t.unit ? `, ${t.unit}` : ''}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        name={`parameter[${p.key}][isRequired]`}
                        value="on"
                        checked={p.isRequired}
                        onChange={(e) =>
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, isRequired: e.target.checked }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`parameter[${p.key}][defaultValue]`}
                        value={p.defaultValue}
                        maxLength={200}
                        placeholder="190"
                        onChange={(e) =>
                          setParameters((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, defaultValue: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost admin-btn--danger"
                        onClick={() =>
                          setParameters((prev) =>
                            prev.filter((r) => r.key !== p.key),
                          )
                        }
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-stack admin-material-requirements">
        <div className="admin-actions-row admin-actions-row--split">
          <strong>Материальные требования</strong>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() => setMaterials((p) => [...p, emptyMaterialRow()])}
          >
            <Plus size={14} strokeWidth={1.6} aria-hidden />
            Добавить
          </button>
        </div>
        <p
          className="admin-muted admin-material-requirements__hint"
          style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.45 }}
        >
          {MATERIAL_REQUIREMENTS_HINT}
        </p>
        {/*
          Два независимых источника подтягивания:
            - слева — конкретная номенклатура (`PatternItem`):
              «Фурнитура и нормы» + «Погонные метры» с непустыми
              значениями;
            - справа — группа номенклатур (`PatternCategory`):
              активные параметры группы с inputType ∈
              { QTY_PER_ITEM, LINEAR_M_BY_SIZE }.
          Target один — общий список строк материалов под блоком.
          Каждый клик ПОЛНОСТЬЮ ЗАМЕНЯЕТ список содержимым выбранного
          источника (см. `handlePullFromNomenclature` /
          `handlePullFromCategory`) — это даёт «снимок» из источника
          вместо мерджа. Внутри одного pull дубликаты по
          `materialRole + fabricType` свёрнуты.
        */}
        <div
          className="admin-material-requirements__pull-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          {/* ── Колонка 1: «Подтянуть из номенклатуры» ─────────────── */}
          <div
            className="admin-stack admin-material-requirements__pull"
            style={{ gap: '0.5rem' }}
          >
            <label
              htmlFor="tc-pull-pattern"
              className="admin-muted"
              style={{ fontSize: '0.85rem' }}
            >
              Номенклатура:
            </label>
            {safePatternItems.length > 0 ? (
              <>
                <select
                  id="tc-pull-pattern"
                  value={pullPatternId}
                  onChange={(e) => setPullPatternId(e.target.value)}
                  disabled={isPulling}
                  data-testid="tech-card-pull-pattern"
                >
                  <option value="">— выберите номенклатуру —</option>
                  {safePatternItems.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.article}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={handlePullFromNomenclature}
                  disabled={isPulling || pullPatternId.trim() === ''}
                  data-testid="tech-card-pull-button"
                  title={
                    pullPatternId.trim() === ''
                      ? 'Сначала выберите номенклатуру выше'
                      : PULL_FROM_NOMENCLATURE_HINT
                  }
                >
                  {isPulling ? 'Подтягиваем…' : 'Подтянуть номенклатуры'}
                </button>
                <p
                  className="admin-muted admin-material-requirements__pull-hint"
                  data-testid="tech-card-pull-hint"
                  style={{
                    margin: 0,
                    fontSize: '0.8rem',
                    lineHeight: 1.45,
                  }}
                >
                  {PULL_FROM_NOMENCLATURE_HINT}
                </p>
                {pullError && (
                  <span
                    className="error-box__msg"
                    role="alert"
                    style={{ fontSize: '0.85rem' }}
                  >
                    {pullError}
                  </span>
                )}
                {pullSummary && (
                  <span
                    className="admin-muted"
                    role="status"
                    data-testid="tech-card-pull-summary"
                    style={{ fontSize: '0.85rem' }}
                  >
                    {pullSummary}
                  </span>
                )}
              </>
            ) : (
              <p
                className="admin-muted"
                style={{ margin: 0, fontSize: '0.85rem' }}
                data-testid="tech-card-pull-empty"
              >
                Активных номенклатур пока нет — подтягивать материалы не из
                чего. Заполните хотя бы одну активную номенклатуру с нормами
                на изделие.
              </p>
            )}
          </div>

          {/* ── Колонка 2: «Подтянуть из группы номенклатур» ───────── */}
          <div
            className="admin-stack admin-material-requirements__pull"
            style={{ gap: '0.5rem' }}
          >
            <label
              htmlFor="tc-pull-category"
              className="admin-muted"
              style={{ fontSize: '0.85rem' }}
            >
              Группа номенклатур:
            </label>
            {safePatternCategories.length > 0 ? (
              <>
                <CreatableSelect
                  entity="patternCategory"
                  id="tc-pull-category"
                  value={pullCategoryId}
                  onValueChange={setPullCategoryId}
                  disabled={isPullingCategory}
                  disableCreate={isPullingCategory}
                  data-testid="tech-card-pull-category"
                  existingValues={safePatternCategories.map((c) => c.id)}
                >
                  <option value="">— выберите группу —</option>
                  {safePatternCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </CreatableSelect>
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={handlePullFromCategory}
                  disabled={
                    isPullingCategory || pullCategoryId.trim() === ''
                  }
                  data-testid="tech-card-pull-category-button"
                  title={
                    pullCategoryId.trim() === ''
                      ? 'Сначала выберите группу выше'
                      : PULL_FROM_CATEGORY_HINT
                  }
                >
                  {isPullingCategory
                    ? 'Подтягиваем…'
                    : 'Подтянуть группу номенклатур'}
                </button>
                <p
                  className="admin-muted"
                  data-testid="tech-card-pull-category-hint"
                  style={{
                    margin: 0,
                    fontSize: '0.8rem',
                    lineHeight: 1.45,
                  }}
                >
                  {PULL_FROM_CATEGORY_HINT}
                </p>
                {pullCategoryError && (
                  <span
                    className="error-box__msg"
                    role="alert"
                    style={{ fontSize: '0.85rem' }}
                  >
                    {pullCategoryError}
                  </span>
                )}
                {pullCategorySummary && (
                  <span
                    className="admin-muted"
                    role="status"
                    data-testid="tech-card-pull-category-summary"
                    style={{ fontSize: '0.85rem' }}
                  >
                    {pullCategorySummary}
                  </span>
                )}
              </>
            ) : (
              <p
                className="admin-muted"
                style={{ margin: 0, fontSize: '0.85rem' }}
                data-testid="tech-card-pull-category-empty"
              >
                Активных групп номенклатур пока нет — подтягивать не из
                чего. Заведите группу с параметрами в разделе «Группы
                номенклатур».
              </p>
            )}
          </div>
        </div>
        {materials.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            Пока пусто — добавьте при необходимости.
          </p>
        ) : (
          <div className="admin-stack" style={{ gap: '0.75rem' }}>
            {materials.map((row) => (
              <MaterialRowCard
                key={row.key}
                row={row}
                techCardId={techCardId}
                onChange={(patch) => updateMaterial(row.key, patch)}
                onImageUploaded={(url, fileName) =>
                  updateMaterial(row.key, {
                    materialImageUrl: url,
                    materialImageOriginalFileName: fileName ?? '',
                  })
                }
                onRemove={() =>
                  setMaterials((p) => p.filter((r) => r.key !== row.key))
                }
              />
            ))}
          </div>
        )}
      </section>

      {/*
        Этап «Техкарта = материальные требования»: блок «Внешние
        потребности» больше не предлагает создавать новые нанесения
        в техкарте (нанесение задаётся в заказе покупателя через
        `OrderApplication`, упаковка — операциями маршрута). Кнопка
        «Добавить» убрана; сами строки рендерятся ТОЛЬКО если у
        старой техкарты они уже есть, и помечены как legacy. Backend
        / Prisma / `TechCardOutsourceLine` не трогаем — это чистый
        UI/compatibility refactor.
      */}
      {outsource.length > 0 && (
        <section className="admin-stack admin-tech-card-outsource-legacy">
          <div className="admin-actions-row admin-actions-row--split">
            <strong>Внешние потребности (legacy)</strong>
          </div>
          <p
            className="admin-muted admin-tech-card-outsource-legacy__hint"
            style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.45 }}
          >
            {OUTSOURCE_LEGACY_HINT}
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Ед.</th>
                  <th style={{ textAlign: 'right' }}>Норма / шт</th>
                  <th>Подрядчик</th>
                  <th>Активация</th>
                  <th>Примечание</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {outsource.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <input
                        name={`outsource[${row.key}][name]`}
                        type="text"
                        value={row.name}
                        onChange={(e) =>
                          updateOutsource(row.key, { name: e.target.value })
                        }
                        placeholder="Шелкография"
                        maxLength={200}
                        style={{ width: '100%' }}
                      />
                    </td>
                    <td>
                      <input
                        name={`outsource[${row.key}][unit]`}
                        type="text"
                        value={row.unit}
                        onChange={(e) =>
                          updateOutsource(row.key, { unit: e.target.value })
                        }
                        placeholder="шт"
                        maxLength={32}
                        style={{ width: 80 }}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        name={`outsource[${row.key}][qtyPerUnit]`}
                        type="text"
                        inputMode="decimal"
                        value={row.qtyPerUnit}
                        onChange={(e) =>
                          updateOutsource(row.key, {
                            qtyPerUnit: e.target.value,
                          })
                        }
                        placeholder="опц."
                        style={{ width: 100, textAlign: 'right' }}
                      />
                    </td>
                    <td>
                      <input
                        name={`outsource[${row.key}][vendorName]`}
                        type="text"
                        value={row.vendorName}
                        onChange={(e) =>
                          updateOutsource(row.key, {
                            vendorName: e.target.value,
                          })
                        }
                        maxLength={120}
                        style={{ width: '100%' }}
                      />
                    </td>
                    <td>
                      <select
                        name={`outsource[${row.key}][triggerType]`}
                        value={row.triggerType}
                        onChange={(e) =>
                          updateOutsource(row.key, {
                            triggerType: e.target.value as OutsourceTriggerType,
                          })
                        }
                        title="Условие готовности (ADR-0022)"
                        style={{ minWidth: 200 }}
                      >
                        <option value="MANUAL">
                          {OUTSOURCE_TRIGGER_LABELS.MANUAL}
                        </option>
                        <option value="CUT_READY">
                          {OUTSOURCE_TRIGGER_LABELS.CUT_READY}
                        </option>
                      </select>
                    </td>
                    <td>
                      <input
                        name={`outsource[${row.key}][note]`}
                        type="text"
                        value={row.note}
                        onChange={(e) =>
                          updateOutsource(row.key, { note: e.target.value })
                        }
                        maxLength={500}
                        style={{ width: '100%' }}
                      />
                    </td>
                    <td className="admin-table__actions">
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        onClick={() =>
                          setOutsource((p) =>
                            p.filter((r) => r.key !== row.key),
                          )
                        }
                        aria-label="Удалить строку"
                        title="Удалить"
                      >
                        <Trash2 size={14} strokeWidth={1.6} aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="admin-actions-row">
        <SubmitButton mode={mode} />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{state.error}</div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <Check size={14} strokeWidth={1.6} aria-hidden />
          {state.successMessage}
        </div>
      )}
    </form>
  );
}

/**
 * Карточка одной строки материала. Этап «Техкарта = материальные
 * требования»:
 *   - видимые поля: роль материала, характеристика полотна,
 *     плотность, плановая ширина рулона, правило цвета,
 *     фиксированный цвет;
 *   - legacy поля (`name`, `unit`, `qtyPerUnit`, `note`) больше
 *     НЕ показываются пользователю — они уходят как hidden inputs
 *     и подменяются на безопасные fallback-значения в
 *     `actions.ts::buildMaterialLines`, если строка создана в
 *     новом UI и не имеет старых значений.
 *
 * Backward-compat: если строка пришла со старой техкарты с
 * заполненными `name`/`unit`/`qtyPerUnit`/`note`, эти значения
 * сохраняются в state-е и уходят hidden-ом обратно — они НЕ теряются.
 *
 * Поле «Фиксированный цвет» активно только при `colorRule =
 * FIXED_COLOR`, иначе backend всё равно зачистит значение в null.
 */
function MaterialRowCard({
  row,
  techCardId,
  onChange,
  onImageUploaded,
  onRemove,
}: {
  row: MaterialRow;
  /**
   * id уже сохранённой техкарты (мы — режим `edit`). null означает,
   * что техкарта ещё не сохранена (`create`-страница) — в этом
   * случае upload изображения недоступен (см. ТЗ §5: «Сохраните
   * техкарту, чтобы загрузить изображение»).
   */
  techCardId: string | null;
  onChange: (patch: Partial<Omit<MaterialRow, 'key'>>) => void;
  /**
   * Колбэк, который форма зовёт после успешной загрузки картинки
   * через server action — обновляем `materialImageUrl` /
   * `materialImageOriginalFileName` в local state, чтобы при
   * следующем submit hidden inputs ушли с актуальным URL.
   */
  onImageUploaded: (url: string, fileName: string | null) => void;
  onRemove: () => void;
}) {
  const isFixedColor = row.colorRule === 'FIXED_COLOR';
  // Этап «Фурнитура в техкарте» (см. ТЗ §3, §7): дополнительные поля
  // показываем только для PACKAGING (UI-метка «Фурнитура»). Для
  // PACKAGING также скрываются поля «Плотность, г/м²» и «Ширина
  // рулона, см» — у фурнитуры этих характеристик нет.
  const isHardware = row.materialRole === 'PACKAGING';
  // Legacy roleKey — это значение в state, которого нет в whitelist
  // `TECH_CARD_MATERIAL_ROLE_KEYS`. Например, APPLICATION со старых
  // техкарт. Показываем как read-only `(legacy)` опцию, чтобы
  // менеджер видел текущее значение, но НЕ предлагаем легаси для
  // новых строк (см. ТЗ §«Совместимость старых техкарт»).
  const isLegacyRole =
    row.materialRole !== '' &&
    !isKnownTechCardMaterialRoleKey(row.materialRole);
  // Подтип строки БОЛЬШЕ НЕ ВЫБИРАЕТСЯ руками (поле «Подтип» убрано,
  // решение пользователя 29.07.2026): он выводится из значения поля
  // «Характеристика». Выбрали из списка знакомое значение («Молния») —
  // строка получает `subtypeKey` и вместе с ним доп. поля подтипа
  // (Тип/Длина) и правила обязательности «ЕСЛИ КГ». Набрали своё —
  // подтипа нет, доп. полей тоже.
  const subtype = row.subtypeKey ? getMaterialSubtype(row.subtypeKey) : null;
  const requiredCharKeys = new Set(
    row.subtypeKey
      ? resolveRequiredCharacteristicKeys(row.subtypeKey, row.unit || 'кг')
      : [],
  );
  const dynamicCharKeys = subtype
    ? subtype.characteristics
        .map((c) => c.key)
        .filter((k) => !LEGACY_CHARACTERISTIC_KEYS.includes(k))
    : [];
  return (
    <div
      className="admin-card admin-material-row"
      style={{
        padding: '0.75rem 0.875rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.625rem',
        background: 'var(--admin-card-subtle, transparent)',
      }}
    >
      {/*
        Скрытые legacy поля (`name`, `unit`, `qtyPerUnit`, `note`).
        Если строка пришла со старой техкарты с заполненными
        значениями — они сохраняются и уходят обратно. Если строка
        создана в новом UI и пустая — `actions.ts::buildMaterialLines`
        подменит их на безопасный fallback (см. doc-комментарий).
      */}
      {/* Ключ строки в форме: по нему параметр находит свою целевую ячейку
          (см. `buildParameters` в actions.ts). В БД не уходит. */}
      <input
        type="hidden"
        name={`material[${row.key}][formKey]`}
        value={row.key}
      />
      <input
        type="hidden"
        name={`material[${row.key}][name]`}
        value={row.name}
      />
      <input
        type="hidden"
        name={`material[${row.key}][unit]`}
        value={row.unit}
      />
      <input
        type="hidden"
        name={`material[${row.key}][qtyPerUnit]`}
        value={row.qtyPerUnit}
      />
      <input
        type="hidden"
        name={`material[${row.key}][note]`}
        value={row.note}
      />
      {/*
        Этап «Изображение материала» (см. ТЗ §5): оригинальное имя
        файла идёт hidden-инпутом — на MVP заполняется только при
        upload, который сделан отдельной задачей. Само поле
        materialImageUrl ниже видимое.
      */}
      <input
        type="hidden"
        name={`material[${row.key}][materialImageOriginalFileName]`}
        value={row.materialImageOriginalFileName}
      />

      <div className="admin-material-row__grid">
        <div className="admin-field">
          <label htmlFor={`mat-${row.key}-role`}>Роль материала</label>
          <select
            id={`mat-${row.key}-role`}
            name={`material[${row.key}][materialRole]`}
            value={row.materialRole}
            onChange={(e) =>
              onChange({
                materialRole: e.target.value,
                // Смена роли обнуляет характеристику и всё, что от неё
                // зависит: список значений привязан к роли, и «Молния»
                // в роли «Основное полотно» — мусор, а не данные.
                fabricType: '',
                subtypeKey: '',
                characteristics: {},
              })
            }
            style={{ width: '100%' }}
          >
            <option value="">— не задано —</option>
            {/*
              Этап «Доработка UI и контракта техкарты» (см. ТЗ §1):
              источник ролей — `PATTERN_CATEGORY_PARAMETER_GROUPS`
              (через re-export `TECH_CARD_MATERIAL_ROLE_KEYS`). UI-
              лейблы берутся через `getTechCardMaterialRoleLabel`,
              которая для PACKAGING возвращает «Фурнитура» (см. ТЗ §1
              «Не возвращать пользователю старый лейбл для PACKAGING»).
              HARDWARE как отдельный roleKey не вводим — фурнитура
              остаётся за PACKAGING (см. ТЗ).
            */}
            {TECH_CARD_MATERIAL_ROLE_KEYS.map((role) => (
              <option key={role} value={role}>
                {getTechCardMaterialRoleLabel(role)}
              </option>
            ))}
            {/*
              Backward-compat: legacy roleKey (например `APPLICATION`,
              ad-hoc-строки старых техкарт) показываем как «текущий
              выбор» с пометкой «(legacy)», чтобы менеджер видел
              значение и мог переключить на новую роль / убрать.
              Whitelist для НОВЫХ строк не содержит таких значений.
            */}
            {isLegacyRole && (
              <option value={row.materialRole}>
                {getTechCardMaterialRoleLabel(row.materialRole)} (legacy)
              </option>
            )}
          </select>
        </div>
        {/*
          Поле «Характеристика» — бывшие «Подтип» + «Характеристика
          полотна», сведённые в один комбобокс (решение пользователя
          29.07.2026, макет
          `docs/mockups/tech-card-characteristic-combobox-mockup.html`).
          Значения бывшего подтипа — первые пункты списка; ниже них
          то, что менеджеры дописали сами.

          `subtypeKey` теперь не выбирается, а ВЫВОДИТСЯ из значения и
          уезжает hidden-инпутом: снапшот заказа, cut-readiness и
          costing продолжают читать привычное поле.
        */}
        <div className="admin-field">
          <label htmlFor={`mat-${row.key}-characteristic`}>Характеристика</label>
          <CharacteristicCombobox
            id={`mat-${row.key}-characteristic`}
            name={`material[${row.key}][fabricType]`}
            roleKey={row.materialRole}
            value={row.fabricType}
            maxLength={120}
            placeholder="кулирка / молния / кашкорсе"
            onChange={(next) => {
              const nextSubtype =
                resolveSubtypeKeyByCharacteristic(row.materialRole, next) ?? '';
              onChange(
                nextSubtype === row.subtypeKey
                  ? { fabricType: next }
                  : {
                      fabricType: next,
                      subtypeKey: nextSubtype,
                      // Подтип задаёт НАБОР характеристик: сменился
                      // подтип — прежние значения относятся к чужим
                      // полям, и тащить их дальше нельзя.
                      characteristics: {},
                    },
              );
            }}
          />
        </div>
        <input
          type="hidden"
          name={`material[${row.key}][subtypeKey]`}
          value={row.subtypeKey}
        />
        {/*
          Динамические характеристики подтипа без legacy-колонки
          (Тип / Длина / Толщина / Ширина / Кол-во проколов). Legacy-
          характеристики (плотность/ширина рулона/размер/материал)
          рендерятся отдельными полями ниже. `*` — обязательная.
        */}
        {dynamicCharKeys.map((k) => {
          const def = getMaterialCharacteristic(k);
          const label = def
            ? def.unit
              ? `${def.label}, ${def.unit}`
              : def.label
            : k;
          const isRequired = requiredCharKeys.has(k);
          return (
            <div className="admin-field" key={k}>
              <label htmlFor={`mat-${row.key}-char-${k}`}>
                {label}
                {isRequired ? ' *' : ''}
              </label>
              <input
                id={`mat-${row.key}-char-${k}`}
                name={`material[${row.key}][char_${k}]`}
                type={def?.valueType === 'number' ? 'number' : 'text'}
                value={row.characteristics[k] ?? ''}
                required={isRequired}
                onChange={(e) =>
                  onChange({
                    characteristics: {
                      ...row.characteristics,
                      [k]: e.target.value,
                    },
                  })
                }
                style={{ width: '100%' }}
              />
            </div>
          );
        })}
        {/*
          Этап «Фурнитура в техкарте» (см. ТЗ §7): для PACKAGING поля
          «Плотность, г/м²» и «Ширина рулона, см» не имеют смысла —
          они применимы только к ткани/полотну. Прячем видимые
          инпуты, чтобы не путать менеджера, и отправляем пустые
          hidden inputs (backend всё равно зачищает в null для
          PACKAGING — см. `materialLineCreateData`).
        */}
        {isHardware ? (
          <>
            <input
              type="hidden"
              name={`material[${row.key}][densityGsm]`}
              value=""
            />
            <input
              type="hidden"
              name={`material[${row.key}][plannedWidthCm]`}
              value=""
            />
          </>
        ) : (
          <>
            <div className="admin-field">
              <label htmlFor={`mat-${row.key}-density`}>Плотность, г/м²</label>
              <input
                id={`mat-${row.key}-density`}
                name={`material[${row.key}][densityGsm]`}
                type="number"
                min={1}
                step={1}
                value={row.densityGsm}
                onChange={(e) => onChange({ densityGsm: e.target.value })}
                placeholder="180"
                style={{ width: '100%', textAlign: 'right' }}
              />
            </div>
            <div className="admin-field">
              <label htmlFor={`mat-${row.key}-width`}>Ширина рулона, см</label>
              <input
                id={`mat-${row.key}-width`}
                name={`material[${row.key}][plannedWidthCm]`}
                type="number"
                min={1}
                step={1}
                value={row.plannedWidthCm}
                onChange={(e) => onChange({ plannedWidthCm: e.target.value })}
                placeholder="180"
                style={{ width: '100%', textAlign: 'right' }}
              />
            </div>
          </>
        )}
        <div className="admin-field">
          <label htmlFor={`mat-${row.key}-color-rule`}>Правило цвета</label>
          <select
            id={`mat-${row.key}-color-rule`}
            name={`material[${row.key}][colorRule]`}
            value={row.colorRule}
            onChange={(e) =>
              onChange({
                colorRule: e.target.value as '' | TechCardMaterialColorRule,
              })
            }
            style={{ width: '100%' }}
          >
            <option value="">— не задано —</option>
            {TECH_CARD_MATERIAL_COLOR_RULES.map((rule) => (
              <option key={rule} value={rule}>
                {TECH_CARD_MATERIAL_COLOR_RULE_LABELS[rule]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor={`mat-${row.key}-fixed-color`}>
            Фиксированный цвет
          </label>
          <input
            id={`mat-${row.key}-fixed-color`}
            name={`material[${row.key}][fixedColorText]`}
            type="text"
            value={row.fixedColorText}
            onChange={(e) => onChange({ fixedColorText: e.target.value })}
            placeholder={isFixedColor ? 'чёрный / графит' : '— не нужно —'}
            maxLength={120}
            disabled={!isFixedColor}
            style={{ width: '100%' }}
            title={
              isFixedColor
                ? 'Заполните цвет, который будет копироваться в snapshot заказа'
                : 'Активно только при правиле «Фиксированный цвет»'
            }
          />
        </div>
        {/*
          Этап «Фурнитура в техкарте» (см. ТЗ §3): дополнительные поля
          для PACKAGING (UI-метка «Фурнитура»). Для других ролей
          инпуты hidden — backend всё равно зачищает в null.
        */}
        {isHardware ? (
          <>
            <div className="admin-field">
              <label htmlFor={`mat-${row.key}-hw-size`}>
                Размер / характеристика
              </label>
              <input
                id={`mat-${row.key}-hw-size`}
                name={`material[${row.key}][hardwareSizeText]`}
                type="text"
                value={row.hardwareSizeText}
                onChange={(e) =>
                  onChange({ hardwareSizeText: e.target.value })
                }
                placeholder="например, 8 мм / люверсы / молния 50 см"
                maxLength={120}
                style={{ width: '100%' }}
                data-testid="material-hardware-size"
              />
            </div>
            <div className="admin-field">
              <label htmlFor={`mat-${row.key}-hw-material`}>Материал</label>
              <input
                id={`mat-${row.key}-hw-material`}
                name={`material[${row.key}][hardwareMaterialText]`}
                type="text"
                value={row.hardwareMaterialText}
                onChange={(e) =>
                  onChange({ hardwareMaterialText: e.target.value })
                }
                placeholder="например, металл / пластик"
                maxLength={120}
                style={{ width: '100%' }}
                data-testid="material-hardware-material"
              />
            </div>
          </>
        ) : (
          <>
            {/*
              Не-PACKAGING: hardware* всё равно отправляем hidden-ом,
              чтобы при переключении роли значения не пропадали из
              state-а формы (backend всё равно зачистит при сохранении
              для не-PACKAGING ролей).
            */}
            <input
              type="hidden"
              name={`material[${row.key}][hardwareSizeText]`}
              value={row.hardwareSizeText}
            />
            <input
              type="hidden"
              name={`material[${row.key}][hardwareMaterialText]`}
              value={row.hardwareMaterialText}
            />
          </>
        )}
        {/*
          Этап «Изображение материала» (см. ТЗ §5, §9): upload файла
          JPG/PNG. URL руками вводить нельзя (см. ТЗ §15 «Не
          использовать URL как основной upload UX») — для свежих
          несохранённых строк показываем подсказку, для существующих
          строк — file input + превью.

          materialImageUrl остаётся в БД (хранит публичный путь
          файла, см. ТЗ §9 «Не удалять поле materialImageUrl из
          Prisma»), но в форме передаётся hidden input-ом — менеджер
          его не редактирует.
        */}
        <input
          type="hidden"
          name={`material[${row.key}][materialImageUrl]`}
          value={row.materialImageUrl}
        />
        <div className="admin-field admin-material-row__image">
          <label>Изображение материала</label>
          <MaterialImageUploader
            techCardId={techCardId}
            lineId={row.existingLineId}
            currentUrl={row.materialImageUrl || null}
            currentFileName={row.materialImageOriginalFileName || null}
            onUploaded={onImageUploaded}
          />
        </div>
        <div className="admin-field admin-material-row__remove">
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onRemove}
            aria-label="Удалить строку"
            title="Удалить"
          >
            <Trash2 size={14} strokeWidth={1.6} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Загрузчик изображения строки материала техкарты (см. ТЗ §5, §9).
 *
 * Поведение по состояниям:
 *   - `techCardId === null` или `lineId === null` → строка ещё не
 *     сохранена в БД. Показываем disabled-кнопку и подсказку
 *     «Сохраните техкарту, чтобы загрузить изображение». Это
 *     сознательный MVP-выбор (см. ТЗ §5): backend-эндпоинт upload-а
 *     адресует строку по конкретному `lineId`, поэтому загружать
 *     можно только после первого save техкарты.
 *   - оба id есть → показываем `<input type="file" accept="...">`
 *     и кнопку «Загрузить»; после успеха обновляем превью и URL
 *     через `onUploaded`-колбэк.
 *
 * URL руками не редактируется (см. ТЗ §9, §15 — «Не использовать
 * URL как основной upload UX»). materialImageUrl при этом продолжает
 * жить в форме hidden-ом, чтобы submit ушёл с актуальным значением
 * (после upload оно уже изменилось через onUploaded).
 */
function MaterialImageUploader({
  techCardId,
  lineId,
  currentUrl,
  currentFileName,
  onUploaded,
}: {
  techCardId: string | null;
  lineId: string | null;
  currentUrl: string | null;
  currentFileName: string | null;
  onUploaded: (url: string, fileName: string | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canUpload = techCardId !== null && lineId !== null;
  const action =
    canUpload
      ? uploadMaterialImageAction.bind(null, techCardId!, lineId!)
      : null;
  const [state, formAction] = useFormState<UploadMaterialImageState, FormData>(
    action ?? noopUploadAction,
    initialUploadMaterialImageState,
  );

  // После успешного upload — синхронизируем local state строки в
  // родительском компоненте, чтобы submit формы шёл с новым URL.
  // useFormState не даёт callback-а на success, поэтому
  // используем эффект через useState-zero-dep idiom: проверяем
  // и зовём, не создавая дополнительный re-render.
  if (state.ok && state.template) {
    const updatedLine = state.template.materialLines.find(
      (l) => l.id === lineId,
    );
    if (
      updatedLine &&
      updatedLine.materialImageUrl &&
      updatedLine.materialImageUrl !== currentUrl
    ) {
      // Defer in microtask to avoid setState-during-render warning.
      queueMicrotask(() =>
        onUploaded(
          updatedLine.materialImageUrl ?? '',
          updatedLine.materialImageOriginalFileName ?? null,
        ),
      );
    }
  }

  if (!canUpload) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: '0.85rem',
        }}
        data-testid="material-image-upload-disabled"
      >
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          disabled
          title="Сохраните техкарту, чтобы загрузить изображение"
          style={{ alignSelf: 'flex-start' }}
        >
          <Upload size={14} strokeWidth={1.6} aria-hidden />
          Загрузить изображение
        </button>
        <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
          Сохраните техкарту, чтобы загрузить изображение.
        </span>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      data-testid="material-image-upload-form"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <input
          ref={fileInputRef}
          type="file"
          name="file"
          accept=".jpg,.jpeg,.png,image/jpeg,image/png"
          style={{ fontSize: '0.85rem' }}
          data-testid="material-image-file-input"
          required
          // После выбора файла сразу submit — менеджеру не нужно
          // нажимать дополнительную кнопку.
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              const formEl = e.currentTarget.form;
              if (formEl) formEl.requestSubmit();
            }
          }}
        />
        <UploadSubmitButton />
      </div>
      {currentUrl ? (
        <a
          href={currentUrl}
          target="_blank"
          rel="noreferrer"
          className="admin-material-row__image-preview"
          title="Открыть изображение в новой вкладке"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentUrl}
            alt={currentFileName ?? 'Изображение материала'}
            style={{
              maxHeight: 64,
              maxWidth: 96,
              objectFit: 'contain',
              border: '1px solid var(--admin-border, #e5e7eb)',
              borderRadius: 4,
            }}
          />
        </a>
      ) : (
        <span
          className="admin-muted"
          style={{ fontSize: '0.8rem', display: 'inline-flex', gap: 4 }}
        >
          <ImageIcon size={12} strokeWidth={1.6} aria-hidden />
          превью появится после загрузки JPG/PNG
        </span>
      )}
      {state.error && (
        <span
          className="error-box__msg"
          role="alert"
          style={{ fontSize: '0.8rem' }}
        >
          {state.error}
        </span>
      )}
    </form>
  );
}

/**
 * Заглушка для `useFormState`, когда upload запрещён (новая
 * несохранённая строка). Хук React требует стабильный action на
 * каждом рендере, поэтому тут нужен постоянный no-op вместо
 * условного `null`.
 */
async function noopUploadAction(
  prev: UploadMaterialImageState,
): Promise<UploadMaterialImageState> {
  return prev;
}

function UploadSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
      style={{ fontSize: '0.85rem' }}
      title="Загрузить выбранный файл (JPG/PNG)"
      data-testid="material-image-upload-submit"
    >
      {pending ? 'Загружаем…' : 'Загрузить'}
    </button>
  );
}
