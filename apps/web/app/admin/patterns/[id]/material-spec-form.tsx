'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import { CheckCircle, Plus, Save, Trash2, XCircle } from 'lucide-react';
import {
  TECH_CARD_PARAMETER_INPUT_TYPES,
  TECH_CARD_PARAMETER_INPUT_TYPE_LABELS,
  TECH_CARD_PARAMETER_TARGETS,
} from '@sewing/shared/tech-card-parameters';
import {
  TECH_CARD_MATERIAL_COLOR_RULES,
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  TECH_CARD_MATERIAL_ROLE_KEYS,
  getTechCardMaterialRoleLabel,
  isKnownTechCardMaterialRoleKey,
  type TechCardMaterialColorRule,
} from '@sewing/shared/tech-cards';
import type {
  PatternItemMaterialLineDto,
  PatternItemSpecParameterDto,
} from '@sewing/shared/pattern-item-spec';
import type { PatternCategoryParameterDto } from '@sewing/shared/pattern-categories';
import {
  getMaterialCharacteristic,
  getMaterialSubtype,
  resolveRequiredCharacteristicKeys,
} from '@sewing/shared/material-characteristics';
import {
  characteristicValueFromSubtypeKey,
  resolveSubtypeKeyByCharacteristic,
} from '@sewing/shared/material-characteristic-options';
import {
  getNormUnitOptions,
  getPurchaseUnitOptions,
} from '@sewing/shared/purchase-units';
import { CharacteristicCombobox } from '@/components/materials/characteristic-combobox';
import { replacePatternItemMaterialSpecAction } from '../actions';
import {
  initialMaterialSpecState,
  type MaterialSpecState,
} from '../form-state';

/**
 * Форма «Материалы (спецификация)» карточки номенклатуры — этап 1 плана
 * «техкарты → номенклатура» (анализ 11.08.2026).
 *
 * Адаптация секций «Параметры техкарты» + «Материальные требования» из
 * `app/admin/tech-cards/tech-card-form.tsx`: тот же state-подход
 * (динамические строки с ключами `specline[<key>][<field>]` /
 * `specparam[<key>][<field>]`, разбор — `buildSpecMaterialLines` /
 * `buildSpecParameters` в `../actions.ts`), те же shared-словари.
 * Дублирование сознательное и временное — форма техкарты умирает на
 * этапе 5 плана вместе с разделом.
 *
 * Отличия от техкарты:
 *   - единицы ВИДИМЫ: «Ед. нормы» / «Ед. закупки» — селекты из
 *     `@sewing/shared/purchase-units` (в техкарте единица закупки была
 *     скрытым legacy-полем с фолбэком «кг»);
 *   - «Норма на изделие» видима, но это ФОЛБЭК: первичный источник
 *     нормы — поразмерные блоки карточки (площади, погонные метры,
 *     нормы на изделие), сопоставляемые со строкой по роли и имени;
 *   - «Подтянуть из группы» работает на клиенте по параметрам
 *     категории карточки (они уже в DTO) — server action не нужен.
 */

interface MaterialRow {
  key: string;
  name: string;
  unit: string;
  normUnit: string;
  qtyPerUnit: string;
  note: string;
  materialRole: string;
  subtypeKey: string;
  characteristics: Record<string, string>;
  fabricType: string;
  densityGsm: string;
  plannedWidthCm: string;
  colorRule: '' | TechCardMaterialColorRule;
  fixedColorText: string;
  hardwareSizeText: string;
  hardwareMaterialText: string;
  materialImageUrl: string;
  materialImageOriginalFileName: string;
}

interface ParameterRow {
  key: string;
  paramKey: string;
  label: string;
  inputType: string;
  options: string;
  unit: string;
  isRequired: boolean;
  defaultValue: string;
  targetRowKey: string;
  targetField: string;
}

// Характеристики с legacy-колонкой рендерятся отдельными полями —
// их НЕ дублируем в динамическом блоке характеристик подтипа.
const LEGACY_CHARACTERISTIC_KEYS = ['density', 'rollWidth', 'size', 'material'];

let __rowKeySeq = 0;
function nextKey(): string {
  __rowKeySeq += 1;
  return `r${Date.now().toString(36)}_${__rowKeySeq}`;
}

/** Стабильный ключ строки из БД — на него ссылаются привязки параметров. */
function lineRowKey(lineId: string): string {
  return `line_${lineId}`;
}

let __paramKeySeq = 0;
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
    name: '',
    unit: '',
    normUnit: '',
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

function normalizeDedupe(value: string | null | undefined): string {
  if (value == null) return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

const PULL_FROM_CATEGORY_HINT =
  'Заполняет строки по всем активным параметрам группы карточки (полотно, фурнитура, погонные метры). Текущий список будет заменён.';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
      data-testid="pattern-material-spec-submit"
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить материалы'}
    </button>
  );
}

interface Props {
  patternId: string;
  lines: readonly PatternItemMaterialLineDto[];
  parameters: readonly PatternItemSpecParameterDto[];
  /**
   * Параметры категории карточки (все, включая AREA_M2_BY_SIZE) — для
   * клиентского предзаполнения «Подтянуть из группы». Пустой массив =
   * у карточки нет категории, кнопка не показывается.
   */
  categoryParameters: readonly PatternCategoryParameterDto[];
}

export function PatternMaterialSpecForm({
  patternId,
  lines,
  parameters,
  categoryParameters,
}: Props) {
  const [materials, setMaterials] = useState<MaterialRow[]>(() =>
    (Array.isArray(lines) ? lines : []).map((l) => ({
      key: lineRowKey(l.id),
      name: l.name,
      unit: l.unit,
      normUnit: l.normUnit ?? l.unit,
      qtyPerUnit: l.qtyPerUnit,
      note: l.note ?? '',
      materialRole: l.materialRole ?? '',
      subtypeKey: l.subtypeKey ?? '',
      characteristics: Object.fromEntries(
        Object.entries(l.characteristics ?? {})
          .filter(([k]) => !LEGACY_CHARACTERISTIC_KEYS.includes(k))
          .map(([k, v]) => [k, String(v)]),
      ),
      fabricType:
        (l.fabricType ?? '') || characteristicValueFromSubtypeKey(l.subtypeKey),
      densityGsm: l.densityGsm == null ? '' : String(l.densityGsm),
      plannedWidthCm: l.plannedWidthCm == null ? '' : String(l.plannedWidthCm),
      colorRule: l.colorRule ?? '',
      fixedColorText: l.fixedColorText ?? '',
      hardwareSizeText: l.hardwareSizeText ?? '',
      hardwareMaterialText: l.hardwareMaterialText ?? '',
      materialImageUrl: l.materialImageUrl ?? '',
      materialImageOriginalFileName: l.materialImageOriginalFileName ?? '',
    })),
  );

  const [parameterRows, setParameterRows] = useState<ParameterRow[]>(() => {
    const list = Array.isArray(parameters) ? parameters : [];
    const lineList = Array.isArray(lines) ? lines : [];
    return list.map((p) => {
      let targetRowKey = '';
      let targetField = '';
      for (const l of lineList) {
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

  const [pullSummary, setPullSummary] = useState<string | null>(null);

  const [state, formAction] = useFormState<MaterialSpecState, FormData>(
    replacePatternItemMaterialSpecAction.bind(null, patternId),
    initialMaterialSpecState,
  );

  const updateMaterial = (
    key: string,
    patch: Partial<Omit<MaterialRow, 'key'>>,
  ) => {
    setMaterials((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  };

  /**
   * «Подтянуть из группы»: клиентское предзаполнение по активным
   * параметрам категории карточки. В отличие от формы техкарты, сюда
   * входят и AREA_M2_BY_SIZE (основное полотно) — спецификация
   * номенклатуры должна покрывать весь состав, а норма площадью
   * сматчится с блоком «Площади материалов» по роли. TEXT_ONLY
   * пропускаем — это текстовые услуги, не материалы.
   */
  const handlePullFromCategory = () => {
    const source = categoryParameters.filter(
      (p) => p.status === 'ACTIVE' && p.inputType !== 'TEXT_ONLY',
    );
    if (source.length === 0) {
      setMaterials([]);
      setPullSummary(
        'В группе нет активных параметров-материалов. Нечего подтягивать.',
      );
      return;
    }
    const seen = new Set<string>();
    const next: MaterialRow[] = [];
    for (const p of source) {
      const k = `${p.roleKey}::${normalizeDedupe(p.label)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const isPackaging = p.roleKey === 'PACKAGING';
      const subtypeKey =
        resolveSubtypeKeyByCharacteristic(p.roleKey, p.label) ??
        p.subtypeKey ??
        '';
      next.push(
        emptyMaterialRow({
          materialRole: p.roleKey,
          fabricType: p.label,
          subtypeKey,
          unit: p.unit,
          normUnit: p.unit,
          qtyPerUnit: '1',
          colorRule: isPackaging ? 'ORDER_SELECTED_COLOR' : 'ORDER_COLOR',
        }),
      );
    }
    setMaterials(next);
    setPullSummary(`Подтянуто строк: ${next.length}. Список заменён.`);
  };

  return (
    <form action={formAction} className="admin-form">
      {/* ── Слоты-параметры спецификации ────────────────────────────── */}
      <section className="admin-stack admin-tech-card-params">
        <div className="admin-actions-row admin-actions-row--split">
          <strong>Параметры спецификации</strong>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            data-testid="pattern-spec-add-parameter"
            onClick={() =>
              setParameterRows((p) => [
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
          не здесь, а в заказе, по каждой расцветке отдельно (например,
          «Плотность»: белые — 160, чёрные — 190).
        </p>

        {parameterRows.length === 0 ? (
          <p className="admin-muted">Пока нет: все ячейки строк заданы жёстко.</p>
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
                {parameterRows.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <input
                        type="hidden"
                        name={`specparam[${p.key}][key]`}
                        value={p.paramKey}
                      />
                      <input
                        type="text"
                        name={`specparam[${p.key}][label]`}
                        value={p.label}
                        maxLength={120}
                        placeholder="Плотность полотна"
                        onChange={(e) =>
                          setParameterRows((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, label: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        name={`specparam[${p.key}][inputType]`}
                        value={p.inputType}
                        onChange={(e) =>
                          setParameterRows((prev) =>
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
                        name={`specparam[${p.key}][options]`}
                        value={p.options}
                        disabled={p.inputType !== 'ENUM'}
                        placeholder="160, 190, 220"
                        onChange={(e) =>
                          setParameterRows((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, options: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`specparam[${p.key}][unit]`}
                        value={p.unit}
                        maxLength={20}
                        placeholder="г/м²"
                        onChange={(e) =>
                          setParameterRows((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? { ...r, unit: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        name={`specparam[${p.key}][target]`}
                        value={
                          p.targetRowKey && p.targetField
                            ? `${p.targetRowKey}|${p.targetField}`
                            : ''
                        }
                        onChange={(e) => {
                          const [rowKey = '', field = ''] =
                            e.target.value.split('|');
                          setParameterRows((prev) =>
                            prev.map((r) =>
                              r.key === p.key
                                ? {
                                    ...r,
                                    targetRowKey: rowKey,
                                    targetField: field,
                                  }
                                : r,
                            ),
                          );
                        }}
                      >
                        <option value="">— не подставляется —</option>
                        {materials.map((m) => (
                          <optgroup
                            key={m.key}
                            label={m.fabricType || m.name || 'Без названия'}
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
                        name={`specparam[${p.key}][isRequired]`}
                        value="on"
                        checked={p.isRequired}
                        onChange={(e) =>
                          setParameterRows((prev) =>
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
                        name={`specparam[${p.key}][defaultValue]`}
                        value={p.defaultValue}
                        maxLength={200}
                        placeholder="190"
                        onChange={(e) =>
                          setParameterRows((prev) =>
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
                          setParameterRows((prev) =>
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

      {/* ── Строки состава материалов ───────────────────────────────── */}
      <section className="admin-stack admin-material-requirements">
        <div className="admin-actions-row admin-actions-row--split">
          <strong>Состав материалов</strong>
          <div className="admin-actions-row" style={{ gap: '0.5rem' }}>
            {categoryParameters.length > 0 && (
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={handlePullFromCategory}
                title={PULL_FROM_CATEGORY_HINT}
                data-testid="pattern-spec-pull-category"
              >
                Подтянуть из группы
              </button>
            )}
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              data-testid="pattern-spec-add-line"
              onClick={() => setMaterials((p) => [...p, emptyMaterialRow()])}
            >
              <Plus size={14} strokeWidth={1.6} aria-hidden />
              Добавить
            </button>
          </div>
        </div>
        <p
          className="admin-muted"
          style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.45 }}
        >
          Спецификация — источник состава материалов изделия. Норма на изделие
          здесь — запасное число: если в карточке заполнены площади, погонные
          метры или нормы на изделие, заказ возьмёт норму оттуда (сопоставление
          по роли и характеристике).
        </p>
        {pullSummary && (
          <span
            className="admin-muted"
            role="status"
            data-testid="pattern-spec-pull-summary"
            style={{ fontSize: '0.85rem' }}
          >
            {pullSummary}
          </span>
        )}

        {materials.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            Пока пусто — подтяните из группы или добавьте строку вручную.
          </p>
        ) : (
          <div className="admin-stack" style={{ gap: '0.75rem' }}>
            {materials.map((row) => (
              <SpecMaterialRowCard
                key={row.key}
                row={row}
                onChange={(patch) => updateMaterial(row.key, patch)}
                onRemove={() =>
                  setMaterials((p) => p.filter((r) => r.key !== row.key))
                }
              />
            ))}
          </div>
        )}
      </section>

      <div className="admin-actions-row">
        <SubmitButton />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden />
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
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}
    </form>
  );
}

/**
 * Карточка одной строки состава. Поля и инварианты — как у строки
 * техкарты (`MaterialRowCard` в tech-card-form.tsx), плюс видимые
 * единицы/норма/примечание. Изображение строки пока едет hidden-ом
 * (upload с карточки номенклатуры — отдельная задача).
 */
function SpecMaterialRowCard({
  row,
  onChange,
  onRemove,
}: {
  row: MaterialRow;
  onChange: (patch: Partial<Omit<MaterialRow, 'key'>>) => void;
  onRemove: () => void;
}) {
  const isFixedColor = row.colorRule === 'FIXED_COLOR';
  const isHardware = row.materialRole === 'PACKAGING';
  const isLegacyRole =
    row.materialRole !== '' &&
    !isKnownTechCardMaterialRoleKey(row.materialRole);
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

  const normUnitOptions = getNormUnitOptions({
    subtypeKey: row.subtypeKey || null,
    materialRole: row.materialRole || null,
    current: row.normUnit || null,
  });
  const purchaseUnitOptions = getPurchaseUnitOptions({
    subtypeKey: row.subtypeKey || null,
    materialRole: row.materialRole || null,
    current: row.unit || null,
    normUnit: row.normUnit || row.unit || 'м пог.',
  });

  return (
    <div
      className="admin-card admin-material-row"
      data-testid="pattern-spec-line"
      style={{
        padding: '0.75rem 0.875rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.625rem',
        background: 'var(--admin-card-subtle, transparent)',
      }}
    >
      {/* Ключ строки в форме: по нему параметр находит целевую ячейку. */}
      <input
        type="hidden"
        name={`specline[${row.key}][formKey]`}
        value={row.key}
      />
      {/* Имя генерится action-ом из характеристики/роли; сохранённое из БД
          значение не теряем. */}
      <input type="hidden" name={`specline[${row.key}][name]`} value={row.name} />
      <input
        type="hidden"
        name={`specline[${row.key}][subtypeKey]`}
        value={row.subtypeKey}
      />
      <input
        type="hidden"
        name={`specline[${row.key}][materialImageUrl]`}
        value={row.materialImageUrl}
      />
      <input
        type="hidden"
        name={`specline[${row.key}][materialImageOriginalFileName]`}
        value={row.materialImageOriginalFileName}
      />

      <div className="admin-material-row__grid">
        <div className="admin-field">
          <label htmlFor={`spec-${row.key}-role`}>Роль материала</label>
          <select
            id={`spec-${row.key}-role`}
            name={`specline[${row.key}][materialRole]`}
            value={row.materialRole}
            onChange={(e) =>
              onChange({
                materialRole: e.target.value,
                // Смена роли обнуляет характеристику и всё, что от неё
                // зависит (список значений привязан к роли).
                fabricType: '',
                subtypeKey: '',
                characteristics: {},
              })
            }
            style={{ width: '100%' }}
          >
            <option value="">— не задано —</option>
            {TECH_CARD_MATERIAL_ROLE_KEYS.map((role) => (
              <option key={role} value={role}>
                {getTechCardMaterialRoleLabel(role)}
              </option>
            ))}
            {isLegacyRole && (
              <option value={row.materialRole}>
                {getTechCardMaterialRoleLabel(row.materialRole)} (legacy)
              </option>
            )}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor={`spec-${row.key}-characteristic`}>
            Характеристика
          </label>
          <CharacteristicCombobox
            id={`spec-${row.key}-characteristic`}
            name={`specline[${row.key}][fabricType]`}
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
                      characteristics: {},
                    },
              );
            }}
          />
        </div>
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
              <label htmlFor={`spec-${row.key}-char-${k}`}>
                {label}
                {isRequired ? ' *' : ''}
              </label>
              <input
                id={`spec-${row.key}-char-${k}`}
                name={`specline[${row.key}][char_${k}]`}
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
        {isHardware ? (
          <>
            <input
              type="hidden"
              name={`specline[${row.key}][densityGsm]`}
              value=""
            />
            <input
              type="hidden"
              name={`specline[${row.key}][plannedWidthCm]`}
              value=""
            />
            <div className="admin-field">
              <label htmlFor={`spec-${row.key}-hw-size`}>Размер</label>
              <input
                id={`spec-${row.key}-hw-size`}
                name={`specline[${row.key}][hardwareSizeText]`}
                type="text"
                value={row.hardwareSizeText}
                maxLength={120}
                placeholder="№5 / 20 мм"
                onChange={(e) => onChange({ hardwareSizeText: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>
            <div className="admin-field">
              <label htmlFor={`spec-${row.key}-hw-material`}>Материал</label>
              <input
                id={`spec-${row.key}-hw-material`}
                name={`specline[${row.key}][hardwareMaterialText]`}
                type="text"
                value={row.hardwareMaterialText}
                maxLength={120}
                placeholder="металл / пластик"
                onChange={(e) =>
                  onChange({ hardwareMaterialText: e.target.value })
                }
                style={{ width: '100%' }}
              />
            </div>
          </>
        ) : (
          <>
            <input
              type="hidden"
              name={`specline[${row.key}][hardwareSizeText]`}
              value=""
            />
            <input
              type="hidden"
              name={`specline[${row.key}][hardwareMaterialText]`}
              value=""
            />
            <div className="admin-field">
              <label htmlFor={`spec-${row.key}-density`}>Плотность, г/м²</label>
              <input
                id={`spec-${row.key}-density`}
                name={`specline[${row.key}][densityGsm]`}
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
              <label htmlFor={`spec-${row.key}-width`}>Ширина рулона, см</label>
              <input
                id={`spec-${row.key}-width`}
                name={`specline[${row.key}][plannedWidthCm]`}
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
          <label htmlFor={`spec-${row.key}-color-rule`}>Правило цвета</label>
          <select
            id={`spec-${row.key}-color-rule`}
            name={`specline[${row.key}][colorRule]`}
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
          <label htmlFor={`spec-${row.key}-fixed-color`}>
            Фиксированный цвет
          </label>
          <input
            id={`spec-${row.key}-fixed-color`}
            name={`specline[${row.key}][fixedColorText]`}
            type="text"
            value={row.fixedColorText}
            onChange={(e) => onChange({ fixedColorText: e.target.value })}
            placeholder={isFixedColor ? 'чёрный / графит' : '— не нужно —'}
            maxLength={120}
            disabled={!isFixedColor}
            style={{ width: '100%' }}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`spec-${row.key}-norm-unit`}>Ед. нормы</label>
          <select
            id={`spec-${row.key}-norm-unit`}
            name={`specline[${row.key}][normUnit]`}
            value={row.normUnit}
            onChange={(e) => {
              const nextNorm = e.target.value;
              // Смена единицы нормы пересобирает словарь закупки: если
              // текущая закупочная в него не входит — сбрасываем на норму.
              const nextPurchaseOptions = getPurchaseUnitOptions({
                subtypeKey: row.subtypeKey || null,
                materialRole: row.materialRole || null,
                current: null,
                normUnit: nextNorm,
              });
              onChange({
                normUnit: nextNorm,
                unit: nextPurchaseOptions.includes(row.unit)
                  ? row.unit
                  : nextNorm,
              });
            }}
            style={{ width: '100%' }}
          >
            {row.normUnit === '' && <option value="">— выберите —</option>}
            {normUnitOptions.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor={`spec-${row.key}-qty`}>Норма на изделие</label>
          <input
            id={`spec-${row.key}-qty`}
            name={`specline[${row.key}][qtyPerUnit]`}
            type="text"
            inputMode="decimal"
            value={row.qtyPerUnit}
            onChange={(e) => onChange({ qtyPerUnit: e.target.value })}
            placeholder="1"
            title="Запасная норма: если в карточке заполнены поразмерные нормы, заказ возьмёт их"
            style={{ width: '100%', textAlign: 'right' }}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`spec-${row.key}-unit`}>Ед. закупки</label>
          <select
            id={`spec-${row.key}-unit`}
            name={`specline[${row.key}][unit]`}
            value={row.unit}
            onChange={(e) => onChange({ unit: e.target.value })}
            disabled={purchaseUnitOptions.length <= 1}
            title={
              purchaseUnitOptions.length <= 1
                ? 'Пересчёт есть только у нормы в погонных метрах — закупка совпадает с нормой'
                : undefined
            }
            style={{ width: '100%' }}
          >
            {row.unit === '' && <option value="">— выберите —</option>}
            {purchaseUnitOptions.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor={`spec-${row.key}-note`}>Примечание</label>
          <input
            id={`spec-${row.key}-note`}
            name={`specline[${row.key}][note]`}
            type="text"
            value={row.note}
            onChange={(e) => onChange({ note: e.target.value })}
            maxLength={500}
            placeholder="—"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div className="admin-actions-row" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="admin-btn admin-btn--ghost admin-btn--danger"
          onClick={onRemove}
          aria-label="Удалить строку"
          title="Удалить строку"
        >
          <Trash2 size={14} strokeWidth={1.6} aria-hidden />
          Удалить строку
        </button>
      </div>
    </div>
  );
}
