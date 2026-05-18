'use client';

/**
 * Окно «Добавить группу номенклатуры» для inline-сценария на
 * `/admin/orders/new`. Открывается из inline-режима «Создать изделие»
 * блока «Изделие» (см. `apps/web/app/admin/orders/new/create-product-inline.tsx`).
 *
 * Поля точно повторяют форму создания категории
 * `apps/web/app/admin/pattern-categories/new/create-pattern-category-form.tsx`:
 *   - название, описание;
 *   - иконка JPG/PNG (превью + сброс) — после успешного создания
 *     грузится через `uploadPatternCategoryIcon` отдельным запросом;
 *   - таблица параметров: `label`, группа (`roleKey`), `inputType`,
 *     `unit`, `isRequired`. Поддержка «быстрых шаблонов» и legacy roleKey.
 *
 * Submit делает client-side вызов нашего server action
 * (`createPatternCategoryFromOrderModalAction`) и при успехе вызывает
 * `onCreated(category)` — родитель сам закрывает окно и автоматически
 * выбирает новую категорию в селекте. Никакого redirect.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import {
  PATTERN_CATEGORY_PARAMETER_GROUPS,
  PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS,
  getPatternCategoryInputUnitLabel,
  getPatternCategoryInputTypeExplanation,
  getPatternCategoryParameterGroupConfig,
  type PatternCategoryDto,
  type PatternCategoryParameterInputType,
} from '@sewing/shared/pattern-categories';
import { DraggableWindow } from './draggable-window';
import {
  createPatternCategoryFromOrderModalAction,
  uploadCategoryIconFromOrderModalAction,
} from './inline-product-actions';

interface ParameterRow {
  uid: string;
  label: string;
  roleKey: string;
  inputType: PatternCategoryParameterInputType;
  unit: string;
  isRequired: boolean;
}

let __uidSeq = 0;
function makeUid(): string {
  __uidSeq += 1;
  return `p_${Date.now().toString(36)}_${__uidSeq}`;
}

function defaultUnitForRole(
  roleKey: string,
  inputType: PatternCategoryParameterInputType,
): string {
  const cfg = getPatternCategoryParameterGroupConfig(roleKey);
  if (cfg?.defaultUnit) return cfg.defaultUnit;
  switch (inputType) {
    case 'AREA_M2_BY_SIZE':
      return 'м²';
    case 'LINEAR_M_BY_SIZE':
      return 'м пог.';
    case 'QTY_PER_ITEM':
      return 'шт';
    case 'TEXT_ONLY':
    default:
      return '';
  }
}

function makeRow(overrides: Partial<ParameterRow> = {}): ParameterRow {
  const roleKey = overrides.roleKey ?? 'MAIN_FABRIC';
  const cfg = getPatternCategoryParameterGroupConfig(roleKey);
  const inputType: PatternCategoryParameterInputType =
    overrides.inputType ??
    cfg?.defaultInputType ??
    'AREA_M2_BY_SIZE';
  return {
    uid: makeUid(),
    label: overrides.label ?? cfg?.label ?? roleKey,
    roleKey,
    inputType,
    unit: overrides.unit ?? defaultUnitForRole(roleKey, inputType),
    isRequired: overrides.isRequired ?? false,
  };
}

interface Template {
  id: string;
  name: string;
  parameters: Partial<ParameterRow>[];
}

const TEMPLATES: Template[] = [
  {
    id: 'tshirt',
    name: 'Футболка',
    parameters: [
      { label: 'Основное полотно', roleKey: 'MAIN_FABRIC', isRequired: true },
      { label: 'Рибана', roleKey: 'RIB' },
    ],
  },
  {
    id: 'hoodie',
    name: 'Худи',
    parameters: [
      { label: 'Основное полотно', roleKey: 'MAIN_FABRIC', isRequired: true },
      { label: 'Кашкорсе', roleKey: 'RIB' },
      { label: 'Подклад', roleKey: 'LINING' },
    ],
  },
];

interface Props {
  onCancel: () => void;
  onCreated: (cat: PatternCategoryDto) => void;
}

export function CreateCategoryWindow({ onCancel, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parameters, setParameters] = useState<ParameterRow[]>(() => [
    makeRow({ label: 'Основное полотно', roleKey: 'MAIN_FABRIC', isRequired: true }),
  ]);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onIconChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setIconFile(f);
    if (!f) {
      setIconPreview(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setIconPreview(typeof reader.result === 'string' ? reader.result : null);
    };
    reader.readAsDataURL(f);
  }, []);

  const clearIcon = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIconFile(null);
    setIconPreview(null);
  }, []);

  const updateRow = useCallback(
    (uid: string, patch: Partial<ParameterRow>) => {
      setParameters((rows) =>
        rows.map((r) => {
          if (r.uid !== uid) return r;
          const next = { ...r, ...patch };
          // Смена группы → подтянуть defaults inputType/unit/label.
          if (patch.roleKey !== undefined && patch.roleKey !== r.roleKey) {
            const cfg = getPatternCategoryParameterGroupConfig(patch.roleKey);
            if (cfg) {
              next.label = next.label === r.label ? cfg.label : next.label;
              next.inputType = cfg.defaultInputType ?? next.inputType;
              next.unit = cfg.defaultUnit ?? next.unit;
            }
          }
          // Смена inputType → подтянуть unit (если у группы определён).
          if (patch.inputType !== undefined && patch.inputType !== r.inputType) {
            next.unit = defaultUnitForRole(next.roleKey, patch.inputType);
          }
          return next;
        }),
      );
    },
    [],
  );

  const removeRow = useCallback((uid: string) => {
    setParameters((rows) => rows.filter((r) => r.uid !== uid));
  }, []);

  const addRow = useCallback(() => {
    setParameters((rows) => [...rows, makeRow()]);
  }, []);

  const applyTemplate = useCallback((tpl: Template) => {
    setParameters(tpl.parameters.map((p) => makeRow(p)));
  }, []);

  const submitDisabled = useMemo(
    () => parameters.length === 0 || !name.trim() || submitting,
    [parameters.length, name, submitting],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createPatternCategoryFromOrderModalAction({
      name: name.trim(),
      description: description.trim() === '' ? undefined : description.trim(),
      parameters: parameters.map((p, i) => ({
        label: p.label,
        roleKey: p.roleKey,
        inputType: p.inputType,
        unit: p.unit,
        isRequired: p.isRequired,
        sortOrder: (i + 1) * 10,
      })),
    });
    if (!result.ok || !result.category) {
      setSubmitting(false);
      setError(result.error ?? 'Не удалось создать группу');
      return;
    }
    // Загружаем иконку отдельно (если выбрана) — multipart-upload через
    // server action (на клиенте `next/headers` недоступен, поэтому
    // делегируем загрузку в `uploadCategoryIconFromOrderModalAction`).
    if (iconFile) {
      const fd = new FormData();
      fd.append('file', iconFile, iconFile.name);
      const uploadResult = await uploadCategoryIconFromOrderModalAction(
        result.category.id,
        fd,
      );
      setSubmitting(false);
      if (uploadResult.ok && uploadResult.category) {
        onCreated(uploadResult.category);
      } else {
        setError(
          uploadResult.error
            ? `Категория создана, но иконку загрузить не удалось: ${uploadResult.error}`
            : 'Категория создана, но иконку загрузить не удалось',
        );
        onCreated(result.category);
      }
      return;
    }
    setSubmitting(false);
    onCreated(result.category);
  }

  return (
    <DraggableWindow
      title="Добавить группу номенклатуры"
      onClose={onCancel}
      initialWidth={820}
    >
      <form className="ccw-form" onSubmit={onSubmit}>
        <section className="ccw-section">
          <h3 className="ccw-section__title">Основное</h3>
          <div className="ccw-field">
            <label htmlFor="ccw-name">Название категории *</label>
            <input
              id="ccw-name"
              type="text"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Худи"
            />
          </div>
          <div className="ccw-field">
            <label htmlFor="ccw-description">Описание</label>
            <textarea
              id="ccw-description"
              maxLength={500}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Свободный комментарий о категории"
            />
          </div>
        </section>

        <section className="ccw-section">
          <h3 className="ccw-section__title">Иконка</h3>
          <p className="ccw-muted">
            JPG / JPEG / PNG. Иконка показывается в фильтрах каталога и
            карточке номенклатуры.
          </p>
          <div className="ccw-icon-row">
            <div className="ccw-icon-preview">
              {iconPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={iconPreview} alt="" width={72} height={72} />
              ) : (
                <Upload size={22} strokeWidth={1.6} color="#64748b" />
              )}
            </div>
            <div className="ccw-icon-controls">
              <label className="ccw-btn ccw-btn--ghost">
                <Upload size={14} strokeWidth={1.7} aria-hidden />
                {iconFile ? 'Заменить файл' : 'Выбрать файл (JPG/PNG)'}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                  onChange={onIconChange}
                  style={{ display: 'none' }}
                />
              </label>
              {iconFile && (
                <div className="ccw-icon-name">
                  <span>{iconFile.name}</span>
                  <button
                    type="button"
                    className="ccw-btn ccw-btn--ghost"
                    onClick={clearIcon}
                    aria-label="Убрать файл"
                  >
                    <Trash2 size={12} strokeWidth={1.7} aria-hidden />
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="ccw-section">
          <h3 className="ccw-section__title">Параметры категории</h3>
          <p className="ccw-muted">
            Параметры определяют, какие расходы заполняются в карточке
            номенклатуры. «Ввод в номенклатуре» — что технолог указывает
            в лекале (площадь по размерам, погонные метры по размерам,
            количество на изделие). «Единица потребности» — в какой
            единице строка попадёт в «Потребность цеха».
          </p>
          <div className="ccw-templates">
            <span className="ccw-muted">Шаблон:</span>
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className="ccw-btn ccw-btn--ghost"
                onClick={() => applyTemplate(t)}
              >
                {t.name}
              </button>
            ))}
          </div>
          <div className="ccw-table-wrap">
            <table className="ccw-table">
              <thead>
                <tr>
                  <th>Название параметра</th>
                  <th>Группа параметра</th>
                  <th>Ввод в номенклатуре</th>
                  <th>Единица потребности</th>
                  <th>Обяз.</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {parameters.map((p) => {
                  const cfg = getPatternCategoryParameterGroupConfig(p.roleKey);
                  const allowedInputTypes = cfg?.allowedInputTypes ?? (
                    Object.keys(
                      PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS,
                    ) as PatternCategoryParameterInputType[]
                  );
                  const allowedUnits = cfg?.allowedUnits ?? [p.unit];
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
                          type="text"
                          required
                          maxLength={100}
                          value={p.label}
                          onChange={(e) =>
                            updateRow(p.uid, { label: e.target.value })
                          }
                          placeholder="Например: Основное полотно"
                        />
                      </td>
                      <td>
                        <select
                          value={p.roleKey}
                          onChange={(e) =>
                            updateRow(p.uid, { roleKey: e.target.value })
                          }
                        >
                          {!cfg && (
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
                          value={p.inputType}
                          onChange={(e) =>
                            updateRow(p.uid, {
                              inputType: e.target.value as PatternCategoryParameterInputType,
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
                          <div className="ccw-hint">
                            Ввод: <strong>{inputUnitLabel}</strong>
                          </div>
                        )}
                      </td>
                      <td>
                        <select
                          value={p.unit}
                          onChange={(e) =>
                            updateRow(p.uid, { unit: e.target.value })
                          }
                        >
                          {!(allowedUnits as readonly string[]).includes(p.unit) && (
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
                        <input
                          type="checkbox"
                          checked={p.isRequired}
                          onChange={(e) =>
                            updateRow(p.uid, { isRequired: e.target.checked })
                          }
                          aria-label={`Параметр «${p.label}» обязателен`}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ccw-btn ccw-btn--ghost"
                          onClick={() => removeRow(p.uid)}
                          aria-label={`Удалить параметр «${p.label}»`}
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
          <div className="ccw-row-actions">
            <button
              type="button"
              className="ccw-btn ccw-btn--ghost"
              onClick={addRow}
            >
              <Plus size={14} strokeWidth={1.7} aria-hidden /> Добавить параметр
            </button>
          </div>
        </section>

        {error && (
          <div className="ccw-error" role="alert">
            {error}
          </div>
        )}

        <footer className="ccw-footer">
          <button
            type="button"
            className="ccw-btn ccw-btn--ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="ccw-btn ccw-btn--primary"
            disabled={submitDisabled}
          >
            {submitting ? 'Сохранение…' : 'Создать категорию'}
          </button>
        </footer>

        <style>{`
          .ccw-form { display: flex; flex-direction: column; gap: 16px; }
          .ccw-section { display: flex; flex-direction: column; gap: 8px; }
          .ccw-section__title { margin: 0 0 4px; font-size: 0.95rem; font-weight: 600; color: #0f172a; }
          .ccw-field { display: flex; flex-direction: column; gap: 4px; }
          .ccw-field label { font-size: 0.85rem; font-weight: 600; color: #1f2937; }
          .ccw-field input, .ccw-field textarea {
            padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px;
            font-size: 0.92rem; background: #fff;
          }
          .ccw-muted { color: #64748b; font-size: 0.82rem; margin: 0; }
          .ccw-icon-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
          .ccw-icon-preview {
            width: 72px; height: 72px;
            border-radius: 8px;
            border: 1px dashed #cbd5e1;
            background: #f1f5f9;
            display: flex; align-items: center; justify-content: center;
            overflow: hidden;
          }
          .ccw-icon-controls { display: flex; flex-direction: column; gap: 6px; }
          .ccw-icon-name { display: flex; align-items: center; gap: 8px; font-size: 0.88rem; }
          .ccw-templates { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
          .ccw-table-wrap { overflow-x: auto; }
          .ccw-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
          .ccw-table th, .ccw-table td {
            border: 1px solid #e2e8f0; padding: 4px 6px;
            text-align: left; vertical-align: middle;
          }
          .ccw-table input, .ccw-table select {
            width: 100%; padding: 4px 6px; border: 1px solid #cbd5e1;
            border-radius: 4px; background: #fff; font-size: 0.88rem;
          }
          .ccw-hint { color: #64748b; font-size: 0.78rem; margin-top: 4px; }
          .ccw-row-actions { display: flex; gap: 8px; }
          .ccw-btn {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 6px 10px; border-radius: 6px; font-size: 0.85rem;
            cursor: pointer; border: 1px solid transparent;
          }
          .ccw-btn--primary { background: #2563eb; color: #fff; border-color: #2563eb; }
          .ccw-btn--primary:hover { background: #1d4ed8; }
          .ccw-btn--ghost { background: #f8fafc; color: #1f2937; border-color: #cbd5e1; }
          .ccw-btn--ghost:hover { background: #e2e8f0; }
          .ccw-btn:disabled { opacity: 0.6; cursor: not-allowed; }
          .ccw-error {
            background: #fee2e2; color: #991b1b;
            border: 1px solid #fecaca;
            padding: 6px 8px; border-radius: 6px; font-size: 0.88rem;
          }
          .ccw-footer {
            display: flex; justify-content: flex-end; gap: 8px;
            border-top: 1px solid #e2e8f0; padding-top: 12px;
          }
        `}</style>
      </form>
    </DraggableWindow>
  );
}
