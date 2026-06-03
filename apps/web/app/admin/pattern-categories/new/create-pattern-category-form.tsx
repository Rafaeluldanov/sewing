'use client';

/**
 * Форма «Создать категорию номенклатуры» (страница
 * `/admin/pattern-categories/new`).
 *
 * UX-инвариант (этап «Доработать параметры категорий номенклатуры»,
 * см. ТЗ §1, §3, §12):
 *   - технические заголовки `roleKey` / `inputType` / `iconKey` /
 *     `sortOrder` / `status` пользователю НЕ показываются. Вместо
 *     `roleKey` — поле «Группа параметра» (whitelist
 *     `PATTERN_CATEGORY_PARAMETER_GROUPS` с понятными лейблами
 *     «Основное полотно», «Дополнительное полотно», «Рибана /
 *     кашкорсе», «Подкладка», «Наполнитель», «Дублерин / клеевые»,
 *     «Нитки», «Фурнитура», «Маркировка»). Старое слово (которое
 *     ассоциировалось с PACKAGING в техкарте) пользователю не
 *     показывается — PACKAGING рендерится как «Фурнитура»;
 *   - «Как заполнять» (inputType) ограничен `allowedInputTypes`
 *     выбранной группы (например, для «Основное полотно» это
 *     «Площадь по размерам» и «Погонные метры по размерам»);
 *   - «Единица» ограничена `allowedUnits` выбранной группы
 *     (например, «м пог.», «кг», «м²» для основного полотна);
 *   - при смене группы default `inputType`/`unit` подставляются
 *     автоматически. Если текущий inputType/unit недопустим в
 *     новой группе — заменяется на default;
 *   - иконка категории грузится файлом JPG/JPEG/PNG (server action
 *     отправляет `iconFile` отдельным multipart-запросом в
 *     `POST /api/pattern-categories/:id/icon`);
 *   - быстрые шаблоны «Футболка» / «Худи» / «Куртка» наполняют
 *     параметры понятными лейблами и выставляют roleKey/inputType/unit
 *     согласно ТЗ §4 «Шаблоны категорий».
 *
 * Контракт `name="param_<i>_*"` повторяет то, что было у удалённой
 * модалки и старой формы — это минимизирует разницу с server-action
 * и упрощает обновление smoke-тестов.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  Plus,
  Trash2,
  Upload,
  XCircle,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import {
  PATTERN_CATEGORY_PARAMETER_GROUPS,
  PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS,
  getDefaultInputTypeForParameterGroup,
  getDefaultUnitForParameterGroup,
  getPatternCategoryInputTypeExplanation,
  getPatternCategoryInputUnitLabel,
  getPatternCategoryParameterGroupConfig,
  type PatternCategoryParameterInputType,
} from '@sewing/shared/pattern-categories';
import { createPatternCategoryPageAction } from './actions';
import {
  initialCreatePatternCategoryPageState,
  type CreatePatternCategoryPageState,
} from './form-state';

// ---------------------------------------------------------------------------
// Параметры формы — локальное состояние строки таблицы.
// ---------------------------------------------------------------------------

interface ParameterRow {
  uid: string;
  /** Пользовательский label, который видит менеджер. */
  label: string;
  /**
   * Технический roleKey группы параметра (`MAIN_FABRIC`,
   * `ADDITIONAL_FABRIC`, `RIB`, `LINING`, `FILLER`, `INTERLINING`,
   * `THREAD`, `PACKAGING`, `MARKING`). Пользователь видит русский
   * лейбл из `PATTERN_CATEGORY_PARAMETER_GROUPS`.
   */
  roleKey: string;
  /** Тип ввода (выбор «Как заполнять»). */
  inputType: PatternCategoryParameterInputType;
  /** Единица измерения (whitelist по группе). */
  unit: string;
  /** Обязательный (checkbox). */
  isRequired: boolean;
}

let nextUid = 0;
function makeUid(): string {
  nextUid += 1;
  return `param-${Date.now()}-${nextUid}`;
}

const FIRST_GROUP = PATTERN_CATEGORY_PARAMETER_GROUPS[0]!;

function makeRow(overrides: Partial<ParameterRow> = {}): ParameterRow {
  const roleKey = overrides.roleKey ?? FIRST_GROUP.roleKey;
  const groupDefaultInputType = getDefaultInputTypeForParameterGroup(roleKey);
  const inputType = overrides.inputType ?? groupDefaultInputType;
  const unit = overrides.unit ?? getDefaultUnitForParameterGroup(roleKey);
  return {
    uid: makeUid(),
    label: '',
    roleKey,
    inputType,
    unit,
    isRequired: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Шаблоны категорий (см. ТЗ §4 «Шаблоны категорий»).
//
// Шаблоны дают пользователю стартовый набор параметров с понятными
// лейблами. roleKey фиксирован из whitelist групп, inputType/unit —
// согласно дефолтам группы и ТЗ.
// ---------------------------------------------------------------------------

interface Template {
  id: string;
  name: string;
  parameters: Array<Pick<ParameterRow, 'label' | 'roleKey' | 'inputType' | 'unit' | 'isRequired'>>;
}

const TEMPLATES: Template[] = [
  {
    id: 'tshirt',
    name: 'Футболка',
    parameters: [
      {
        label: 'Основное полотно',
        roleKey: 'MAIN_FABRIC',
        // Технолог вводит м пог. по размерам, в потребность строка
        // попадает в кг (через ширину рулона и плотность из техкарты).
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'кг',
        isRequired: true,
      },
      {
        label: 'Нитки',
        roleKey: 'THREAD',
        inputType: 'QTY_PER_ITEM',
        unit: 'м',
        isRequired: false,
      },
      {
        label: 'Маркировка',
        roleKey: 'MARKING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
    ],
  },
  {
    id: 'hoodie',
    name: 'Худи',
    parameters: [
      {
        label: 'Основное полотно',
        roleKey: 'MAIN_FABRIC',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'кг',
        isRequired: true,
      },
      {
        label: 'Рибана / кашкорсе',
        roleKey: 'RIB',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'кг',
        isRequired: false,
      },
      {
        label: 'Нитки',
        roleKey: 'THREAD',
        inputType: 'QTY_PER_ITEM',
        unit: 'м',
        isRequired: false,
      },
      {
        label: 'Люверсы',
        roleKey: 'PACKAGING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
      {
        label: 'Шнур',
        roleKey: 'PACKAGING',
        inputType: 'QTY_PER_ITEM',
        unit: 'м',
        isRequired: false,
      },
      {
        label: 'Наконечники',
        roleKey: 'PACKAGING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
      {
        label: 'Маркировка',
        roleKey: 'MARKING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
    ],
  },
  {
    id: 'jacket',
    name: 'Куртка',
    parameters: [
      {
        label: 'Основное полотно',
        roleKey: 'MAIN_FABRIC',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'кг',
        isRequired: true,
      },
      {
        label: 'Подкладка',
        roleKey: 'LINING',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'м пог.',
        isRequired: false,
      },
      {
        label: 'Наполнитель',
        roleKey: 'FILLER',
        inputType: 'TEXT_ONLY',
        unit: 'г/м²',
        isRequired: false,
      },
      {
        label: 'Дублерин / клеевые',
        roleKey: 'INTERLINING',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'м пог.',
        isRequired: false,
      },
      {
        label: 'Молния',
        roleKey: 'PACKAGING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
      {
        label: 'Кнопки',
        roleKey: 'PACKAGING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
      {
        label: 'Маркировка',
        roleKey: 'MARKING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
    ],
  },
  {
    // Сохранён как удобный шаблон поверх ТЗ §4 (в основном пакете
    // шаблонов отсутствует, но менеджер привычно создаёт «Поло» —
    // оставляем рядом с «Футболкой» и «Худи»).
    id: 'polo',
    name: 'Поло',
    parameters: [
      {
        label: 'Основное полотно',
        roleKey: 'MAIN_FABRIC',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'кг',
        isRequired: true,
      },
      {
        label: 'Воротник / манжеты',
        roleKey: 'RIB',
        inputType: 'LINEAR_M_BY_SIZE',
        unit: 'кг',
        isRequired: false,
      },
      {
        label: 'Нитки',
        roleKey: 'THREAD',
        inputType: 'QTY_PER_ITEM',
        unit: 'м',
        isRequired: false,
      },
      {
        label: 'Пуговицы',
        roleKey: 'PACKAGING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
      {
        label: 'Маркировка',
        roleKey: 'MARKING',
        inputType: 'QTY_PER_ITEM',
        unit: 'шт',
        isRequired: false,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers: при смене группы — синхронизировать inputType / unit.
// ---------------------------------------------------------------------------

function syncRowOnRoleChange(row: ParameterRow, nextRoleKey: string): ParameterRow {
  const config = getPatternCategoryParameterGroupConfig(nextRoleKey);
  if (!config) {
    // Custom-группа: оставляем что есть, но обновляем roleKey.
    return { ...row, roleKey: nextRoleKey };
  }
  const allowedInputTypes = config.allowedInputTypes;
  const inputType = (allowedInputTypes as readonly string[]).includes(
    row.inputType,
  )
    ? row.inputType
    : config.defaultInputType;
  const allowedUnits = config.allowedUnits;
  const unit = (allowedUnits as readonly string[]).includes(row.unit)
    ? row.unit
    : config.defaultUnit;
  return { ...row, roleKey: nextRoleKey, inputType, unit };
}

function syncRowOnInputTypeChange(
  row: ParameterRow,
  nextInputType: PatternCategoryParameterInputType,
): ParameterRow {
  const config = getPatternCategoryParameterGroupConfig(row.roleKey);
  // Если текущий unit недопустим для новой пары (group, inputType),
  // подставим дефолт unit группы. На MVP allowedUnits зависит только
  // от группы (не от inputType), так что unit оставляем как есть,
  // если он валиден.
  if (!config) return { ...row, inputType: nextInputType };
  const allowedUnits = config.allowedUnits;
  const unit = (allowedUnits as readonly string[]).includes(row.unit)
    ? row.unit
    : config.defaultUnit;
  return { ...row, inputType: nextInputType, unit };
}

// ---------------------------------------------------------------------------
// Submit-кнопка.
// ---------------------------------------------------------------------------

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={disabled || pending}
    >
      <Plus size={16} strokeWidth={1.7} aria-hidden />
      {pending ? 'Сохраняем…' : 'Создать категорию'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Главный компонент.
// ---------------------------------------------------------------------------

export function CreatePatternCategoryForm() {
  const [state, formAction] = useFormState<
    CreatePatternCategoryPageState,
    FormData
  >(createPatternCategoryPageAction, initialCreatePatternCategoryPageState);

  const [parameters, setParameters] = useState<ParameterRow[]>(() => [
    makeRow({
      label: 'Основное полотно',
      roleKey: 'MAIN_FABRIC',
      isRequired: true,
    }),
  ]);

  // ---- Иконка ------------------------------------------------------------
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconName, setIconName] = useState<string | null>(null);

  const handleIconChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      setIconPreview(null);
      setIconName(null);
      return;
    }
    setIconName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      setIconPreview(typeof result === 'string' ? result : null);
    };
    reader.readAsDataURL(file);
  }, []);

  const clearIcon = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIconPreview(null);
    setIconName(null);
  }, []);

  // ---- Параметры ---------------------------------------------------------

  const updateParameter = useCallback(
    (uid: string, patch: Partial<ParameterRow>) => {
      setParameters((rows) =>
        rows.map((r) => {
          if (r.uid !== uid) return r;
          let next = { ...r, ...patch };
          if (patch.roleKey !== undefined && patch.roleKey !== r.roleKey) {
            next = syncRowOnRoleChange(next, patch.roleKey);
          }
          if (
            patch.inputType !== undefined &&
            patch.inputType !== r.inputType
          ) {
            next = syncRowOnInputTypeChange(next, patch.inputType);
          }
          return next;
        }),
      );
    },
    [],
  );

  const removeParameter = useCallback((uid: string) => {
    setParameters((rows) => rows.filter((r) => r.uid !== uid));
  }, []);

  const moveParameter = useCallback((uid: string, dir: -1 | 1) => {
    setParameters((rows) => {
      const idx = rows.findIndex((r) => r.uid === uid);
      if (idx === -1) return rows;
      const target = idx + dir;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

  const addParameter = useCallback(() => {
    setParameters((rows) => [...rows, makeRow()]);
  }, []);

  const applyTemplate = useCallback((tpl: Template) => {
    setParameters(tpl.parameters.map((p) => makeRow(p)));
  }, []);

  // ---- Render ------------------------------------------------------------

  const submitDisabled = useMemo(
    () => parameters.length === 0,
    [parameters.length],
  );

  return (
    <form
      action={formAction}
      className="admin-form"
      encType="multipart/form-data"
    >
      {/* ===================================================== */}
      {/* Блок 1. Основное                                       */}
      {/* ===================================================== */}
      <section
        aria-labelledby="cat-create-section-main"
        style={{ marginBottom: 24 }}
      >
        <h3 id="cat-create-section-main" className="admin-section-title">
          Основное
        </h3>
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="cat-name">Название категории</label>
            <input
              id="cat-name"
              name="name"
              type="text"
              required
              maxLength={100}
              placeholder="Например: Худи"
            />
          </div>
        </div>
        <div className="admin-field">
          <label htmlFor="cat-description">Описание</label>
          <textarea
            id="cat-description"
            name="description"
            maxLength={500}
            rows={2}
            placeholder="Свободный комментарий о категории"
          />
        </div>
      </section>

      {/* ===================================================== */}
      {/* Блок 2. Иконка                                         */}
      {/* ===================================================== */}
      <section
        aria-labelledby="cat-create-section-icon"
        style={{ marginBottom: 24 }}
      >
        <h3 id="cat-create-section-icon" className="admin-section-title">
          Иконка
        </h3>
        <p className="admin-muted" style={{ marginBottom: 12 }}>
          Загрузите JPG или PNG-иконку категории. Поддерживаются JPG, JPEG и
          PNG. Иконка отображается в фильтрах и карточке номенклатуры.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 72,
              height: 72,
              borderRadius: 8,
              border: '1px dashed var(--admin-border-soft, #cbd5e1)',
              background: 'var(--admin-surface-muted, #f1f5f9)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {iconPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={iconPreview}
                alt=""
                width={72}
                height={72}
                style={{ width: 72, height: 72, objectFit: 'cover' }}
              />
            ) : (
              <Upload
                size={22}
                strokeWidth={1.6}
                color="var(--admin-text-muted, #64748b)"
              />
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              className="admin-btn admin-btn--ghost"
              style={{ cursor: 'pointer', alignSelf: 'flex-start' }}
            >
              <Upload size={14} strokeWidth={1.7} aria-hidden />
              {iconName ? 'Заменить файл' : 'Выбрать файл (JPG/PNG)'}
              <input
                ref={fileInputRef}
                name="iconFile"
                type="file"
                accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                onChange={handleIconChange}
                style={{ display: 'none' }}
              />
            </label>
            {iconName && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: '0.9rem',
                }}
              >
                <span>{iconName}</span>
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={clearIcon}
                  aria-label="Убрать выбранный файл"
                >
                  <Trash2 size={12} strokeWidth={1.7} aria-hidden />
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ===================================================== */}
      {/* Блок 3. Параметры категории                            */}
      {/* ===================================================== */}
      <section aria-labelledby="cat-create-section-params">
        <h3
          id="cat-create-section-params"
          className="admin-section-title"
        >
          Параметры категории
        </h3>
        <p className="admin-muted" style={{ marginBottom: 12 }}>
          Параметры определяют, какие расходы нужно заполнить в карточке
          номенклатуры. Поле «Ввод в номенклатуре» задаёт, что технолог
          указывает в лекале (погонные метры по размерам, площадь по
          размерам, количество на изделие). Поле «Единица потребности»
          задаёт, в какой единице строка попадёт в «Потребность цеха»
          (кг / м пог. / м² / шт / м). Например, «Погонные метры по
          размерам» + «кг» означает, что технолог вводит расход в м пог., а
          в потребность строка пересчитывается в кг через ширину рулона и
          плотность из техкарты.
        </p>

        {/* Быстрые шаблоны */}
        <div
          aria-label="Быстрые шаблоны"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}
        >
          <span className="admin-muted" style={{ alignSelf: 'center' }}>
            Шаблон:
          </span>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => applyTemplate(t)}
            >
              {t.name}
            </button>
          ))}
        </div>

        <input
          type="hidden"
          name="__paramCount"
          value={parameters.length}
          readOnly
        />
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            {/* Фиксируем ширину колонки «Единица потребности» через
                `<col>` (см. globals.css —
                `.pattern-category-param-table__unit-col` = 150 px),
                чтобы длинный select-инпут не растягивал строку. */}
            <colgroup>
              <col />
              <col />
              <col />
              <col className="pattern-category-param-table__unit-col" />
              <col className="pattern-category-param-table__required-col" />
              <col className="pattern-category-param-table__actions-col" />
            </colgroup>
            <thead>
              <tr>
                <th>Название параметра</th>
                <th>Группа параметра</th>
                <th>
                  Ввод в номенклатуре
                  <div
                    className="admin-muted"
                    style={{ fontSize: '0.78rem', fontWeight: 400 }}
                  >
                    Что заполняет технолог в лекале
                  </div>
                </th>
                <th>
                  <span
                    className="admin-inline-help"
                    title="В этой единице строка попадёт в «Потребность цеха»."
                  >
                    Единица потребности
                    <span
                      className="admin-inline-help__icon"
                      aria-hidden="true"
                    >
                      ⓘ
                    </span>
                  </span>
                </th>
                <th>Обязательный</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {parameters.map((p, i) => {
                const groupConfig = getPatternCategoryParameterGroupConfig(
                  p.roleKey,
                );
                const allowedInputTypes =
                  groupConfig?.allowedInputTypes ??
                  (Object.keys(
                    PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS,
                  ) as PatternCategoryParameterInputType[]);
                const allowedUnits = groupConfig?.allowedUnits ?? [p.unit];
                const inputUnitLabel = getPatternCategoryInputUnitLabel(
                  p.inputType,
                );
                const inputExplanation = getPatternCategoryInputTypeExplanation(
                  p.inputType,
                );
                return (
                  <tr key={p.uid}>
                    <td>
                      <input
                        name={`param_${i}_label`}
                        type="text"
                        required
                        maxLength={100}
                        value={p.label}
                        onChange={(e) =>
                          updateParameter(p.uid, { label: e.target.value })
                        }
                        placeholder="Например: Основное полотно"
                        style={{ width: 200 }}
                      />
                    </td>
                    <td>
                      <select
                        name={`param_${i}_roleKey`}
                        value={p.roleKey}
                        onChange={(e) =>
                          updateParameter(p.uid, {
                            roleKey: e.target.value,
                          })
                        }
                      >
                        {/* Если у параметра custom-roleKey, сохраняем его
                            в опциях, чтобы select не «сбросил» значение
                            при ререндере. */}
                        {!groupConfig && (
                          <option value={p.roleKey}>
                            {p.roleKey} (своя группа)
                          </option>
                        )}
                        {PATTERN_CATEGORY_PARAMETER_GROUPS.map((g) => (
                          <option key={g.roleKey} value={g.roleKey}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        name={`param_${i}_inputType`}
                        value={p.inputType}
                        onChange={(e) =>
                          updateParameter(p.uid, {
                            inputType: e.target
                              .value as PatternCategoryParameterInputType,
                          })
                        }
                        title={inputExplanation}
                      >
                        {allowedInputTypes.map((it) => (
                          <option key={it} value={it}>
                            {PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS[it]}
                          </option>
                        ))}
                      </select>
                      {inputUnitLabel && (
                        <div
                          className="admin-muted"
                          style={{ fontSize: '0.78rem', marginTop: 4 }}
                        >
                          Ввод: <strong>{inputUnitLabel}</strong>
                        </div>
                      )}
                    </td>
                    <td>
                      <select
                        name={`param_${i}_unit`}
                        value={p.unit}
                        onChange={(e) =>
                          updateParameter(p.uid, { unit: e.target.value })
                        }
                        className="pattern-category-param-row__unit"
                        title="В этой единице строка попадёт в «Потребность цеха»."
                        aria-label="Единица потребности"
                      >
                        {/* Если в БД лежит custom unit (не из whitelist
                            группы), показываем его опцией, чтобы не
                            «сбросить» при редактировании. */}
                        {!(allowedUnits as readonly string[]).includes(
                          p.unit,
                        ) && (
                          <option value={p.unit}>{p.unit || '—'}</option>
                        )}
                        {allowedUnits.map((u) => (
                          <option key={u} value={u}>
                            {u || '—'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {/* React всегда отправляет hidden=off для unchecked
                          checkbox-ов; в native html, наоборот, отсутствие
                          ключа = false. Чтобы action всегда видел поле и
                          корректно парсил `'on' | '1'` → bool, отдаём
                          состояние через два input-а. */}
                      {p.isRequired && (
                        <input
                          type="hidden"
                          name={`param_${i}_isRequired`}
                          value="on"
                        />
                      )}
                      <input
                        type="checkbox"
                        checked={p.isRequired}
                        onChange={(e) =>
                          updateParameter(p.uid, {
                            isRequired: e.target.checked,
                          })
                        }
                        aria-label={`Параметр «${p.label || '—'}» обязателен`}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          onClick={() => moveParameter(p.uid, -1)}
                          disabled={i === 0}
                          aria-label={`Переместить параметр «${p.label || '—'}» вверх`}
                          title="Вверх"
                        >
                          <ChevronUp size={14} strokeWidth={1.6} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          onClick={() => moveParameter(p.uid, 1)}
                          disabled={i === parameters.length - 1}
                          aria-label={`Переместить параметр «${p.label || '—'}» вниз`}
                          title="Вниз"
                        >
                          <ChevronDown size={14} strokeWidth={1.6} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          onClick={() => removeParameter(p.uid)}
                          aria-label={`Удалить параметр «${p.label || '—'}»`}
                        >
                          <Trash2 size={14} strokeWidth={1.6} aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={addParameter}
          >
            <Plus size={14} strokeWidth={1.7} aria-hidden /> Добавить параметр
          </button>
        </div>
      </section>

      {state.error && (
        <div className="error-box" role="alert" style={{ marginTop: 16 }}>
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.iconWarning && (
        <div
          role="alert"
          style={{
            marginTop: 16,
            padding: '10px 12px',
            borderRadius: 6,
            background: 'var(--admin-warning-soft, #fef3c7)',
            color: 'var(--admin-warning-fg, #92400e)',
            border: '1px solid var(--admin-warning, #b45309)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <AlertTriangle size={16} strokeWidth={1.6} aria-hidden />
          <span>{state.iconWarning}</span>
        </div>
      )}

      <div className="admin-actions-row" style={{ marginTop: 20 }}>
        <SubmitButton disabled={submitDisabled} />
      </div>
    </form>
  );
}
