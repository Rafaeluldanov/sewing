'use client';

/**
 * Окно «Добавить техкарту» для inline-сценария на `/admin/orders/new`.
 * Открывается из inline-режима «Создать изделие» блока «Изделие»
 * (см. `apps/web/app/admin/orders/new/create-product-inline.tsx`).
 *
 * Поля повторяют форму создания техкарты
 * `apps/web/app/admin/tech-cards/tech-card-form.tsx`:
 *   - code (уникальный), name, isActive;
 *   - привязка к группе номенклатуры (`patternCategoryId`) — фиксируется
 *     текущим выбором в окне «Изделие», menager не меняет;
 *   - таблица строк материалов: `name`, `unit`, `qtyPerUnit`, `note`,
 *     `materialRole`, `fabricType`, `densityGsm`, `plannedWidthCm`,
 *     `colorRule`, `fixedColorText`, hardware-поля (для PACKAGING),
 *     URL картинки;
 *   - таблица внешних подрядов (outsource): `name`, `unit`,
 *     `qtyPerUnit`, `vendorName`, `note`, `triggerType`.
 *
 * Submit делает client-side вызов нашего server action
 * (`createTechCardFromOrderModalAction`) и при успехе вызывает
 * `onCreated(techCard)` — родитель закрывает окно и выбирает её в
 * селекте.
 *
 * Если предзаполнение задано (`prefilledMaterialLines`), стартовые
 * строки берутся из выбранной категории — backend заодно проверит
 * совместимость техкарты с категорией при использовании на заказе.
 */

import { useCallback, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  TECH_CARD_MATERIAL_COLOR_RULES,
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  TECH_CARD_MATERIAL_ROLE_KEYS,
  getTechCardMaterialRoleLabel,
  type TechCardMaterialColorRule,
  type TechCardMaterialLineInputDto,
  type TechCardTemplateDetailDto,
  type OutsourceTriggerType,
} from '@sewing/shared/tech-cards';
import { DraggableWindow } from './draggable-window';
import { createTechCardFromOrderModalAction } from './inline-product-actions';

type MaterialRow = {
  key: string;
  name: string;
  unit: string;
  qtyPerUnit: string;
  note: string;
  materialRole: string;
  fabricType: string;
  densityGsm: string;
  plannedWidthCm: string;
  colorRule: '' | TechCardMaterialColorRule;
  fixedColorText: string;
  hardwareSizeText: string;
  hardwareMaterialText: string;
  materialImageUrl: string;
  materialImageOriginalFileName: string;
};

type OutsourceRow = {
  key: string;
  name: string;
  unit: string;
  qtyPerUnit: string;
  vendorName: string;
  note: string;
  triggerType: OutsourceTriggerType;
};

let __seq = 0;
function nextKey(): string {
  __seq += 1;
  return `r${Date.now().toString(36)}_${__seq}`;
}

function emptyMaterial(seed: Partial<MaterialRow> = {}): MaterialRow {
  return {
    key: nextKey(),
    name: '',
    unit: 'кг',
    qtyPerUnit: '1.0000',
    note: '',
    materialRole: '',
    fabricType: '',
    densityGsm: '',
    plannedWidthCm: '',
    colorRule: 'ORDER_COLOR',
    fixedColorText: '',
    hardwareSizeText: '',
    hardwareMaterialText: '',
    materialImageUrl: '',
    materialImageOriginalFileName: '',
    ...seed,
  };
}

function emptyOutsource(): OutsourceRow {
  return {
    key: nextKey(),
    name: '',
    unit: '',
    qtyPerUnit: '',
    vendorName: '',
    note: '',
    triggerType: 'MANUAL',
  };
}

export interface PrefilledMaterialLineSeed {
  name: string;
  materialRole: string;
  fabricType?: string;
  unit?: string;
  qtyPerUnit?: string;
}

interface Props {
  onCancel: () => void;
  onCreated: (techCard: TechCardTemplateDetailDto) => void;
  /** Опционально: привязка к выбранной группе номенклатуры. */
  patternCategoryId?: string | null;
  /** Опционально: предзаполнить строки материалов под параметры категории. */
  prefilledMaterialLines?: PrefilledMaterialLineSeed[];
  /** Опционально: предложенный `code` (например, по выбранной категории). */
  suggestedCode?: string;
  /** Опционально: предложенное `name`. */
  suggestedName?: string;
}

export function CreateTechCardWindow({
  onCancel,
  onCreated,
  patternCategoryId = null,
  prefilledMaterialLines = [],
  suggestedCode = '',
  suggestedName = '',
}: Props) {
  const [code, setCode] = useState(suggestedCode);
  const [name, setName] = useState(suggestedName);
  const [isActive, setIsActive] = useState(true);
  const [materials, setMaterials] = useState<MaterialRow[]>(() =>
    prefilledMaterialLines.length > 0
      ? prefilledMaterialLines.map((s) =>
          emptyMaterial({
            name: s.name,
            materialRole: s.materialRole,
            fabricType: s.fabricType ?? s.name,
            unit: s.unit ?? 'кг',
            qtyPerUnit: s.qtyPerUnit ?? '1.0000',
          }),
        )
      : [emptyMaterial()],
  );
  const [outsource, setOutsource] = useState<OutsourceRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateMaterial = useCallback(
    (key: string, patch: Partial<MaterialRow>) => {
      setMaterials((rows) =>
        rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
      );
    },
    [],
  );
  const removeMaterial = useCallback((key: string) => {
    setMaterials((rows) => rows.filter((r) => r.key !== key));
  }, []);
  const addMaterial = useCallback(() => {
    setMaterials((rows) => [...rows, emptyMaterial()]);
  }, []);

  const updateOutsource = useCallback(
    (key: string, patch: Partial<OutsourceRow>) => {
      setOutsource((rows) =>
        rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
      );
    },
    [],
  );
  const removeOutsource = useCallback((key: string) => {
    setOutsource((rows) => rows.filter((r) => r.key !== key));
  }, []);
  const addOutsource = useCallback(() => {
    setOutsource((rows) => [...rows, emptyOutsource()]);
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!code.trim()) {
      setError('Укажите код техкарты');
      return;
    }
    if (!name.trim()) {
      setError('Укажите название техкарты');
      return;
    }

    // Сериализуем материальные строки в формат, который ждёт
    // shared-схема `TechCardMaterialLineInputSchema`.
    const materialLines: TechCardMaterialLineInputDto[] = materials.map((m) => {
      const isPackaging = m.materialRole === 'PACKAGING';
      const colorRule = (m.colorRule === '' ? null : m.colorRule) ?? null;
      return {
        name: m.name.trim(),
        unit: m.unit.trim() || 'шт',
        qtyPerUnit: m.qtyPerUnit.trim().replace(',', '.') || '1',
        note: m.note.trim() === '' ? null : m.note.trim(),
        materialRole: m.materialRole.trim() === '' ? null : m.materialRole.trim(),
        fabricType: m.fabricType.trim() === '' ? null : m.fabricType.trim(),
        densityGsm:
          m.densityGsm.trim() === '' ? null : Number(m.densityGsm) || null,
        plannedWidthCm:
          m.plannedWidthCm.trim() === ''
            ? null
            : Number(m.plannedWidthCm) || null,
        colorRule,
        fixedColorText:
          colorRule === 'FIXED_COLOR'
            ? m.fixedColorText.trim() || null
            : null,
        hardwareSizeText: isPackaging
          ? m.hardwareSizeText.trim() || null
          : null,
        hardwareMaterialText: isPackaging
          ? m.hardwareMaterialText.trim() || null
          : null,
        materialImageUrl:
          m.materialImageUrl.trim() === '' ? null : m.materialImageUrl.trim(),
        materialImageOriginalFileName:
          m.materialImageOriginalFileName.trim() === ''
            ? null
            : m.materialImageOriginalFileName.trim(),
      };
    });

    const outsourceLines = outsource.map((o) => ({
      name: o.name.trim(),
      unit: o.unit.trim() === '' ? null : o.unit.trim(),
      qtyPerUnit:
        o.qtyPerUnit.trim() === ''
          ? null
          : o.qtyPerUnit.trim().replace(',', '.'),
      vendorName: o.vendorName.trim() === '' ? null : o.vendorName.trim(),
      note: o.note.trim() === '' ? null : o.note.trim(),
      triggerType: o.triggerType,
    }));

    setSubmitting(true);
    const result = await createTechCardFromOrderModalAction({
      code: code.trim(),
      name: name.trim(),
      isActive,
      patternCategoryId: patternCategoryId ?? null,
      materialLines,
      outsourceLines,
    });
    setSubmitting(false);
    if (result.ok && result.techCard) {
      onCreated(result.techCard);
    } else {
      setError(result.error ?? 'Не удалось создать техкарту');
    }
  }

  return (
    <DraggableWindow
      title="Добавить техкарту"
      onClose={onCancel}
      initialWidth={1000}
    >
      <form className="ctw-form" onSubmit={onSubmit}>
        <section className="ctw-section">
          <div className="ctw-grid-2">
            <div className="ctw-field">
              <label htmlFor="ctw-code">Код *</label>
              <input
                id="ctw-code"
                type="text"
                required
                maxLength={64}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Например: HOODIE-MAT"
              />
            </div>
            <div className="ctw-field">
              <label htmlFor="ctw-name">Название *</label>
              <input
                id="ctw-name"
                type="text"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например: Худи трёхнить"
              />
            </div>
          </div>
          <div className="ctw-field ctw-field--row">
            <label>
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />{' '}
              Активна
            </label>
            {patternCategoryId && (
              <span className="ctw-muted">
                Техкарта будет привязана к выбранной группе номенклатуры.
              </span>
            )}
          </div>
        </section>

        <section className="ctw-section">
          <header className="ctw-section__header">
            <h3 className="ctw-section__title">Материалы</h3>
            <button
              type="button"
              className="ctw-btn ctw-btn--ghost"
              onClick={addMaterial}
            >
              <Plus size={14} strokeWidth={1.7} aria-hidden /> Добавить строку
            </button>
          </header>
          {materials.length === 0 ? (
            <p className="ctw-muted">Нет строк материалов.</p>
          ) : (
            <div className="ctw-table-wrap">
              <table className="ctw-table">
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Роль</th>
                    <th>Тип полотна</th>
                    <th>Плотн., г/м²</th>
                    <th>Ширина, см</th>
                    <th>Ед.</th>
                    <th>Норма / шт</th>
                    <th>Правило цвета</th>
                    <th>Фикс. цвет</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {materials.map((m) => {
                    const isPackaging = m.materialRole === 'PACKAGING';
                    return (
                      <tr key={m.key}>
                        <td>
                          <input
                            type="text"
                            value={m.name}
                            onChange={(e) =>
                              updateMaterial(m.key, { name: e.target.value })
                            }
                            placeholder="Название"
                            required
                          />
                        </td>
                        <td>
                          <select
                            value={m.materialRole}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                materialRole: e.target.value,
                              })
                            }
                          >
                            <option value="">— без роли —</option>
                            {/* Текущая роль может быть legacy (не из whitelist) —
                                сохраняем её в опциях, чтобы select не сбросил. */}
                            {m.materialRole &&
                              !TECH_CARD_MATERIAL_ROLE_KEYS.includes(
                                m.materialRole,
                              ) && (
                                <option value={m.materialRole}>
                                  {m.materialRole} (legacy)
                                </option>
                              )}
                            {TECH_CARD_MATERIAL_ROLE_KEYS.map((rk) => (
                              <option key={rk} value={rk}>
                                {getTechCardMaterialRoleLabel(rk)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={m.fabricType}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                fabricType: e.target.value,
                              })
                            }
                            placeholder="Кулирка / Кашкорсе…"
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={m.densityGsm}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                densityGsm: e.target.value,
                              })
                            }
                            disabled={isPackaging}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={m.plannedWidthCm}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                plannedWidthCm: e.target.value,
                              })
                            }
                            disabled={isPackaging}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={m.unit}
                            onChange={(e) =>
                              updateMaterial(m.key, { unit: e.target.value })
                            }
                            placeholder="кг"
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={m.qtyPerUnit}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                qtyPerUnit: e.target.value,
                              })
                            }
                            placeholder="1.0000"
                          />
                        </td>
                        <td>
                          <select
                            value={m.colorRule}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                colorRule:
                                  e.target.value as MaterialRow['colorRule'],
                              })
                            }
                          >
                            <option value="">— не задано —</option>
                            {TECH_CARD_MATERIAL_COLOR_RULES.map((r) => (
                              <option key={r} value={r}>
                                {TECH_CARD_MATERIAL_COLOR_RULE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={m.fixedColorText}
                            onChange={(e) =>
                              updateMaterial(m.key, {
                                fixedColorText: e.target.value,
                              })
                            }
                            disabled={m.colorRule !== 'FIXED_COLOR'}
                            placeholder="чёрный"
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="ctw-btn ctw-btn--ghost"
                            onClick={() => removeMaterial(m.key)}
                            aria-label="Удалить строку"
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
          )}
        </section>

        <section className="ctw-section">
          <header className="ctw-section__header">
            <h3 className="ctw-section__title">
              Внешние подрядные размещения
            </h3>
            <button
              type="button"
              className="ctw-btn ctw-btn--ghost"
              onClick={addOutsource}
            >
              <Plus size={14} strokeWidth={1.7} aria-hidden /> Добавить строку
            </button>
          </header>
          {outsource.length === 0 ? (
            <p className="ctw-muted">
              Нет строк подряда. Их можно добавить позже в карточке техкарты.
            </p>
          ) : (
            <div className="ctw-table-wrap">
              <table className="ctw-table">
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Подрядчик</th>
                    <th>Ед.</th>
                    <th>Норма / шт</th>
                    <th>Триггер</th>
                    <th>Заметка</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {outsource.map((o) => (
                    <tr key={o.key}>
                      <td>
                        <input
                          type="text"
                          value={o.name}
                          onChange={(e) =>
                            updateOutsource(o.key, { name: e.target.value })
                          }
                          required
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={o.vendorName}
                          onChange={(e) =>
                            updateOutsource(o.key, {
                              vendorName: e.target.value,
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={o.unit}
                          onChange={(e) =>
                            updateOutsource(o.key, { unit: e.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={o.qtyPerUnit}
                          onChange={(e) =>
                            updateOutsource(o.key, {
                              qtyPerUnit: e.target.value,
                            })
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={o.triggerType}
                          onChange={(e) =>
                            updateOutsource(o.key, {
                              triggerType: e.target
                                .value as OutsourceTriggerType,
                            })
                          }
                        >
                          <option value="MANUAL">Ручной</option>
                          <option value="CUT_READY">Когда крой готов</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={o.note}
                          onChange={(e) =>
                            updateOutsource(o.key, { note: e.target.value })
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ctw-btn ctw-btn--ghost"
                          onClick={() => removeOutsource(o.key)}
                          aria-label="Удалить строку"
                        >
                          <Trash2 size={14} strokeWidth={1.6} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {error && (
          <div className="ctw-error" role="alert">
            {error}
          </div>
        )}

        <footer className="ctw-footer">
          <button
            type="button"
            className="ctw-btn ctw-btn--ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="ctw-btn ctw-btn--primary"
            disabled={submitting}
          >
            {submitting ? 'Сохранение…' : 'Создать техкарту'}
          </button>
        </footer>

        <style>{`
          .ctw-form { display: flex; flex-direction: column; gap: 16px; }
          .ctw-section { display: flex; flex-direction: column; gap: 8px; }
          .ctw-section__header {
            display: flex; justify-content: space-between; align-items: center;
          }
          .ctw-section__title { margin: 0; font-size: 0.95rem; font-weight: 600; color: #0f172a; }
          .ctw-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .ctw-field { display: flex; flex-direction: column; gap: 4px; }
          .ctw-field--row { flex-direction: row; align-items: center; gap: 12px; }
          .ctw-field label { font-size: 0.85rem; font-weight: 600; color: #1f2937; }
          .ctw-field input, .ctw-field textarea, .ctw-field select {
            padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px;
            font-size: 0.92rem; background: #fff;
          }
          .ctw-muted { color: #64748b; font-size: 0.82rem; margin: 0; }
          .ctw-table-wrap { overflow-x: auto; }
          .ctw-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
          .ctw-table th, .ctw-table td {
            border: 1px solid #e2e8f0; padding: 3px 4px;
            text-align: left; vertical-align: middle;
          }
          .ctw-table input, .ctw-table select {
            width: 100%; padding: 3px 5px; border: 1px solid #cbd5e1;
            border-radius: 4px; background: #fff; font-size: 0.82rem;
          }
          .ctw-table input:disabled, .ctw-table select:disabled {
            background: #f1f5f9; color: #94a3b8;
          }
          .ctw-btn {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 6px 10px; border-radius: 6px; font-size: 0.85rem;
            cursor: pointer; border: 1px solid transparent;
          }
          .ctw-btn--primary { background: #2563eb; color: #fff; border-color: #2563eb; }
          .ctw-btn--primary:hover { background: #1d4ed8; }
          .ctw-btn--ghost { background: #f8fafc; color: #1f2937; border-color: #cbd5e1; }
          .ctw-btn--ghost:hover { background: #e2e8f0; }
          .ctw-btn:disabled { opacity: 0.6; cursor: not-allowed; }
          .ctw-error {
            background: #fee2e2; color: #991b1b;
            border: 1px solid #fecaca;
            padding: 6px 8px; border-radius: 6px; font-size: 0.88rem;
          }
          .ctw-footer {
            display: flex; justify-content: flex-end; gap: 8px;
            border-top: 1px solid #e2e8f0; padding-top: 12px;
          }
        `}</style>
      </form>
    </DraggableWindow>
  );
}
