'use client';

/**
 * Форма «Редактировать категорию номенклатуры»
 * (страница `/admin/pattern-categories/[id]`).
 *
 * UX-инвариант повторяет форму создания категории
 * (`apps/web/app/admin/pattern-categories/new/create-pattern-category-form.tsx`):
 *
 *   - «Группа параметра» (бывший roleKey) — select из
 *     `PATTERN_CATEGORY_PARAMETER_GROUPS` с понятными лейблами
 *     («Основное полотно», «Дополнительное полотно», «Рибана /
 *     кашкорсе», «Подкладка», «Наполнитель», «Дублерин / клеевые»,
 *     «Нитки», «Фурнитура», «Маркировка»). Старое слово (которое
 *     ассоциировалось с PACKAGING в техкарте) пользователю не
 *     показывается;
 *   - «Как заполнять» (inputType) ограничен `allowedInputTypes`
 *     группы; «Единица» — `allowedUnits` группы;
 *   - при смене группы default inputType/unit подставляются
 *     автоматически (если текущие значения недопустимы — заменяются
 *     на default);
 *   - иконка грузится отдельным multipart-запросом
 *     `POST /api/pattern-categories/:id/icon`.
 *
 * Из отличий от создания:
 *   - предзаполнение по `category` (включая список параметров);
 *   - отдельный server-action `archivePatternCategoryPageAction`,
 *     висящий на кнопке «Архивировать»;
 *   - редиректа после «Сохранить» нет — пользователь остаётся на
 *     странице и видит свежее состояние (revalidate-pattern).
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
  AlertTriangle,
  ArchiveX,
  ArrowLeft,
  CheckCircle,
  Plus,
  Save,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import {
  PATTERN_CATEGORY_PARAMETER_GROUPS,
  PATTERN_CATEGORY_PARAMETER_INPUT_TYPES,
  PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS,
  getDefaultInputTypeForParameterGroup,
  getDefaultUnitForParameterGroup,
  getPatternCategoryInputTypeExplanation,
  getPatternCategoryInputUnitLabel,
  getPatternCategoryParameterGroupConfig,
  type PatternCategoryDto,
  type PatternCategoryParameterDto,
  type PatternCategoryParameterInputType,
} from '@sewing/shared/pattern-categories';
import {
  getMaterialSubtype,
  getMaterialSubtypesByGroup,
} from '@sewing/shared/material-characteristics';
import {
  archivePatternCategoryPageAction,
  editPatternCategoryPageAction,
} from './actions';
import { DeletePatternCategoryButton } from './delete-pattern-category-button';
import {
  initialEditPatternCategoryPageState,
  type EditPatternCategoryPageState,
} from './form-state';

// ---------------------------------------------------------------------------
// Параметры формы — локальное состояние строки таблицы.
// ---------------------------------------------------------------------------

interface ParameterRow {
  uid: string;
  label: string;
  /**
   * Технический roleKey группы параметра. Whitelist —
   * `PATTERN_CATEGORY_PARAMETER_GROUPS`. Custom-roleKey
   * (исторические данные) сохраняем как есть, чтобы select не
   * «сбросил» значение при ререндере.
   */
  roleKey: string;
  /**
   * Ключ подтипа из `MATERIAL_SUBTYPES` (таблица TEEON.pdf). `null` =
   * «Другое» (ручной ввод названия). При выборе подтипа авто-заполняются
   * название, «Ввод» и «Единица».
   */
  subtypeKey: string | null;
  inputType: PatternCategoryParameterInputType;
  unit: string;
  isRequired: boolean;
}

let nextUid = 0;
function makeUid(): string {
  nextUid += 1;
  return `param-${Date.now()}-${nextUid}`;
}

const DEFAULT_GROUP = PATTERN_CATEGORY_PARAMETER_GROUPS[0]!;

function rowFromParameter(p: PatternCategoryParameterDto): ParameterRow {
  const inputType = (
    PATTERN_CATEGORY_PARAMETER_INPUT_TYPES as readonly string[]
  ).includes(p.inputType)
    ? (p.inputType as PatternCategoryParameterInputType)
    : ('AREA_M2_BY_SIZE' as PatternCategoryParameterInputType);
  return {
    uid: makeUid(),
    label: p.label,
    roleKey: p.roleKey,
    subtypeKey: p.subtypeKey ?? null,
    inputType,
    unit: p.unit ?? '',
    isRequired: !!p.isRequired,
  };
}

function makeEmptyRow(): ParameterRow {
  return {
    uid: makeUid(),
    label: '',
    roleKey: DEFAULT_GROUP.roleKey,
    subtypeKey: null,
    inputType: DEFAULT_GROUP.defaultInputType,
    unit: DEFAULT_GROUP.defaultUnit,
    isRequired: false,
  };
}

function syncRowOnRoleChange(row: ParameterRow, nextRoleKey: string): ParameterRow {
  const config = getPatternCategoryParameterGroupConfig(nextRoleKey);
  // Смена группы сбрасывает подтип: подтипы привязаны к группе, старый
  // выбор в новой группе невалиден.
  if (!config) {
    return { ...row, roleKey: nextRoleKey, subtypeKey: null };
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
  return { ...row, roleKey: nextRoleKey, subtypeKey: null, inputType, unit };
}

// Выбор подтипа из таблицы TEEON.pdf авто-заполняет название, «Ввод» и
// «Единицу» (значения остаются редактируемыми). Пустой выбор = «Другое»
// (ручной ввод) — поля не трогаем, только сбрасываем subtypeKey.
function syncRowOnSubtypeChange(
  row: ParameterRow,
  nextSubtypeKey: string,
): ParameterRow {
  if (nextSubtypeKey === '') {
    return { ...row, subtypeKey: null };
  }
  const subtype = getMaterialSubtype(nextSubtypeKey);
  if (!subtype) return { ...row, subtypeKey: nextSubtypeKey };
  const config = getPatternCategoryParameterGroupConfig(row.roleKey);
  const inputType =
    config &&
    !(config.allowedInputTypes as readonly string[]).includes(
      subtype.defaultInputType,
    )
      ? config.defaultInputType
      : subtype.defaultInputType;
  const allowedUnits = config?.allowedUnits ?? subtype.allowedUnits;
  const unit = (allowedUnits as readonly string[]).includes(subtype.defaultUnit)
    ? subtype.defaultUnit
    : (config?.defaultUnit ?? subtype.defaultUnit);
  return {
    ...row,
    subtypeKey: nextSubtypeKey,
    label: subtype.label,
    inputType,
    unit,
  };
}

function syncRowOnInputTypeChange(
  row: ParameterRow,
  nextInputType: PatternCategoryParameterInputType,
): ParameterRow {
  const config = getPatternCategoryParameterGroupConfig(row.roleKey);
  if (!config) return { ...row, inputType: nextInputType };
  const allowedUnits = config.allowedUnits;
  const unit = (allowedUnits as readonly string[]).includes(row.unit)
    ? row.unit
    : config.defaultUnit;
  return { ...row, inputType: nextInputType, unit };
}

// ---------------------------------------------------------------------------
// Submit-кнопки.
// ---------------------------------------------------------------------------

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={disabled || pending}
    >
      <Save size={16} strokeWidth={1.7} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function ArchiveButton({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
      onClick={(e) => {
        if (
          !window.confirm(
            `Архивировать категорию «${name}»? Лекала, привязанные к ней, потеряют связь с категорией.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <ArchiveX size={16} strokeWidth={1.7} aria-hidden />
      {pending ? 'Архивируем…' : 'Архивировать категорию'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Главный компонент.
// ---------------------------------------------------------------------------

interface Props {
  category: PatternCategoryDto;
}

export function EditPatternCategoryForm({ category }: Props) {
  const [state, formAction] = useFormState<
    EditPatternCategoryPageState,
    FormData
  >(
    editPatternCategoryPageAction.bind(null, category.id),
    initialEditPatternCategoryPageState,
  );

  const [archiveState, archiveFormAction] = useFormState<
    EditPatternCategoryPageState,
    FormData
  >(
    archivePatternCategoryPageAction.bind(null, category.id),
    initialEditPatternCategoryPageState,
  );

  const [parameters, setParameters] = useState<ParameterRow[]>(() =>
    category.parameters.length === 0
      ? [makeEmptyRow()]
      : category.parameters.map(rowFromParameter),
  );

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
            patch.subtypeKey !== undefined &&
            patch.subtypeKey !== r.subtypeKey
          ) {
            next = syncRowOnSubtypeChange(next, patch.subtypeKey ?? '');
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

  const addParameter = useCallback(() => {
    setParameters((rows) => [...rows, makeEmptyRow()]);
  }, []);

  const submitDisabled = useMemo(
    () => parameters.length === 0,
    [parameters.length],
  );

  const currentIconUrl = category.iconImageUrl;
  const previewUrl = iconPreview ?? currentIconUrl ?? null;

  return (
    <>
      <form
        action={formAction}
        className="admin-form"
        encType="multipart/form-data"
      >
        {/* ===================================================== */}
        {/* Блок 1. Основное                                       */}
        {/* ===================================================== */}
        <section
          aria-labelledby="cat-edit-section-main"
          style={{ marginBottom: 24 }}
        >
          <h3 id="cat-edit-section-main" className="admin-section-title">
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
                defaultValue={category.name}
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
              defaultValue={category.description ?? ''}
              placeholder="Свободный комментарий о категории"
            />
          </div>
        </section>

        {/* ===================================================== */}
        {/* Блок 2. Иконка                                         */}
        {/* ===================================================== */}
        <section
          aria-labelledby="cat-edit-section-icon"
          style={{ marginBottom: 24 }}
        >
          <h3 id="cat-edit-section-icon" className="admin-section-title">
            Иконка
          </h3>
          <p className="admin-muted" style={{ marginBottom: 12 }}>
            Загрузите JPG или PNG, чтобы заменить текущую иконку категории.
            Поддерживаются JPG, JPEG и PNG. Иконка отображается в фильтрах
            каталога и карточках лекал.
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
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
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
              {currentIconUrl && !iconPreview && (
                <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
                  Сейчас:{' '}
                  {category.iconOriginalFileName ?? 'загруженная иконка'}
                </span>
              )}
              <label
                className="admin-btn admin-btn--ghost"
                style={{ cursor: 'pointer', alignSelf: 'flex-start' }}
              >
                <Upload size={14} strokeWidth={1.7} aria-hidden />
                {iconName
                  ? 'Заменить файл'
                  : currentIconUrl
                    ? 'Загрузить новую (JPG/PNG)'
                    : 'Выбрать файл (JPG/PNG)'}
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
        <section aria-labelledby="cat-edit-section-params">
          <h3
            id="cat-edit-section-params"
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
            размерам» + «кг» означает, что технолог вводит расход в м пог.,
            а в потребность строка пересчитывается в кг через ширину
            рулона и плотность из состава материалов.
          </p>

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
                  чтобы select-инпут не растягивал строку. */}
              <colgroup>
                <col />
                <col />
                <col />
                <col />
                <col className="pattern-category-param-table__unit-col" />
                <col className="pattern-category-param-table__required-col" />
                <col className="pattern-category-param-table__actions-col" />
              </colgroup>
              <thead>
                <tr>
                  <th>Группа параметра</th>
                  <th>Параметр</th>
                  <th>Название параметра</th>
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
                  const subtypes = groupConfig
                    ? getMaterialSubtypesByGroup(p.roleKey)
                    : [];
                  const allowedInputTypes =
                    groupConfig?.allowedInputTypes ??
                    PATTERN_CATEGORY_PARAMETER_INPUT_TYPES;
                  const allowedUnits = groupConfig?.allowedUnits ?? [p.unit];
                  const inputUnitLabel = getPatternCategoryInputUnitLabel(
                    p.inputType,
                  );
                  const inputExplanation =
                    getPatternCategoryInputTypeExplanation(p.inputType);
                  return (
                    <tr key={p.uid}>
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
                        {/* Подтип из таблицы TEEON.pdf для выбранной
                            группы. «Другое (вручную)» = свободный ввод
                            названия (subtypeKey пуст). */}
                        <input
                          type="hidden"
                          name={`param_${i}_subtypeKey`}
                          value={p.subtypeKey ?? ''}
                        />
                        <select
                          value={p.subtypeKey ?? ''}
                          onChange={(e) =>
                            updateParameter(p.uid, {
                              subtypeKey: e.target.value || null,
                            })
                          }
                          aria-label="Параметр (подтип)"
                          disabled={subtypes.length === 0}
                        >
                          <option value="">Другое (вручную)</option>
                          {subtypes.map((s) => (
                            <option key={s.subtypeKey} value={s.subtypeKey}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </td>
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
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost"
                          onClick={() => removeParameter(p.uid)}
                          aria-label={`Удалить параметр «${p.label || '—'}»`}
                        >
                          <Trash2 size={14} strokeWidth={1.6} aria-hidden />
                        </button>
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
              <Plus size={14} strokeWidth={1.7} aria-hidden /> Добавить
              параметр
            </button>
          </div>
        </section>

        {state.error && (
          <div className="error-box" role="alert" style={{ marginTop: 16 }}>
            <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
          </div>
        )}
        {state.ok && state.successMessage && !state.iconWarning && (
          <div className="success-box" role="status" style={{ marginTop: 16 }}>
            <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
            {state.successMessage}
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

        <div className="admin-actions-row" style={{ marginTop: 20, gap: 8 }}>
          <SaveButton disabled={submitDisabled} />
          <Link href="/admin/patterns" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К номенклатуре
          </Link>
        </div>
      </form>

      {/* Архивирование — отдельный <form>, чтобы кнопка не сабмитила
          основные правки и не несла лишний FormData в DELETE-action. */}
      <form
        action={archiveFormAction}
        style={{ marginTop: 20 }}
      >
        <ArchiveButton name={category.name} />
        {archiveState.error && (
          <div className="error-box" role="alert" style={{ marginTop: 12 }}>
            <XCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
            {archiveState.error}
          </div>
        )}
      </form>

      {/* Hard-delete: компонент сам рисует кнопку только для ARCHIVED. */}
      <DeletePatternCategoryButton
        categoryId={category.id}
        categoryName={category.name}
        status={category.status}
        patternsCount={category.patternsCount}
      />
    </>
  );
}
