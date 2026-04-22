'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';
import { Icon } from '@/components/icon';
import { createTechCardAction, updateTechCardAction } from './actions';
import {
  initialTechCardFormState,
  type TechCardFormState,
} from './form-state';

type Mode = 'create' | 'edit';

interface Props {
  mode: Mode;
  /** Только в режиме `edit` — текущее состояние техкарты. */
  template?: TechCardTemplateDetailDto;
}

interface MaterialRow {
  key: string;
  name: string;
  unit: string;
  qtyPerUnit: string;
  note: string;
}

interface OutsourceRow {
  key: string;
  name: string;
  unit: string;
  qtyPerUnit: string;
  vendorName: string;
  note: string;
}

let __rowKeySeq = 0;
function nextKey(): string {
  __rowKeySeq += 1;
  return `r${Date.now().toString(36)}_${__rowKeySeq}`;
}

function emptyMaterialRow(): MaterialRow {
  return { key: nextKey(), name: '', unit: '', qtyPerUnit: '', note: '' };
}
function emptyOutsourceRow(): OutsourceRow {
  return {
    key: nextKey(),
    name: '',
    unit: '',
    qtyPerUnit: '',
    vendorName: '',
    note: '',
  };
}

function SubmitButton({ mode }: { mode: Mode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name={mode === 'create' ? 'plus' : 'success'} size={16} />
      {pending
        ? 'Сохраняем…'
        : mode === 'create'
        ? 'Создать техкарту'
        : 'Сохранить изменения'}
    </button>
  );
}

/**
 * Универсальная форма техкарты: используется на `/admin/tech-cards/new`
 * и `/admin/tech-cards/[id]`. По UX повторяет `RouteTemplateForm` и
 * `EquipmentOperationsForm`:
 *   - простые поля наверху (`code`, `name`, `isActive`);
 *   - две независимые секции строк (материалы / внешние подряды);
 *   - add row / remove row, без drag-and-drop;
 *   - `sortOrder` НЕ передаётся: backend нормализует его как
 *     `(i + 1) * 10` по позиции в массиве (см. ADR-0022).
 *
 * Имена полей `material[<key>][<field>]` сохраняют группировку
 * строк в FormData; server action парсит их в правильном порядке.
 */
export function TechCardForm({ mode, template }: Props) {
  const [materials, setMaterials] = useState<MaterialRow[]>(() => {
    if (mode !== 'edit' || !template) return [];
    return template.materialLines.map((l) => ({
      key: nextKey(),
      name: l.name,
      unit: l.unit,
      qtyPerUnit: l.qtyPerUnit,
      note: l.note ?? '',
    }));
  });
  const [outsource, setOutsource] = useState<OutsourceRow[]>(() => {
    if (mode !== 'edit' || !template) return [];
    return template.outsourceLines.map((l) => ({
      key: nextKey(),
      name: l.name,
      unit: l.unit ?? '',
      qtyPerUnit: l.qtyPerUnit ?? '',
      vendorName: l.vendorName ?? '',
      note: l.note ?? '',
    }));
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

  return (
    <form action={formAction} className="admin-equipment-form">
      {mode === 'edit' && template && (
        <input type="hidden" name="id" value={template.id} />
      )}

      <div className="admin-equipment-form__meta" style={{ flexWrap: 'wrap' }}>
        <label htmlFor="tc-code" className="meta-line">
          Код техкарты
        </label>
        <input
          id="tc-code"
          name="code"
          type="text"
          maxLength={48}
          required
          autoComplete="off"
          defaultValue={template?.code ?? ''}
          placeholder="например, TSHIRT-BASIC"
          pattern="[A-Z0-9][A-Z0-9_-]*"
          title="Латинские заглавные буквы, цифры, '-' и '_'"
          style={{ padding: '6px 10px', minWidth: 220 }}
        />
        <label htmlFor="tc-name" className="meta-line">
          Название
        </label>
        <input
          id="tc-name"
          name="name"
          type="text"
          maxLength={120}
          required
          autoComplete="off"
          defaultValue={template?.name ?? ''}
          placeholder="например, Базовая футболка"
          style={{ padding: '6px 10px', minWidth: 280 }}
        />
        <label
          className="meta-line"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <input
            type="checkbox"
            name="isActive"
            value="on"
            defaultChecked={template?.isActive ?? true}
          />
          Активна
        </label>
      </div>

      <section>
        <div
          className="meta-line"
          style={{
            marginBottom: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
          }}
        >
          <strong>Материалы</strong>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setMaterials((p) => [...p, emptyMaterialRow()])}
          >
            <Icon name="plus" size={14} />
            Добавить строку
          </button>
        </div>
        {materials.length === 0 ? (
          <div className="meta-line" style={{ marginBottom: '0.5rem' }}>
            Пока нет строк материалов — добавьте при необходимости.
          </div>
        ) : (
          <table className="data-table" style={{ marginBottom: '0.5rem' }}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Единица</th>
                <th className="num">Норма / 1 шт</th>
                <th>Примечание</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((row) => (
                <tr key={row.key}>
                  <td>
                    <input
                      name={`material[${row.key}][name]`}
                      type="text"
                      value={row.name}
                      onChange={(e) =>
                        updateMaterial(row.key, { name: e.target.value })
                      }
                      placeholder="например, Ткань рибана"
                      maxLength={200}
                      style={{ width: '100%' }}
                    />
                  </td>
                  <td>
                    <input
                      name={`material[${row.key}][unit]`}
                      type="text"
                      value={row.unit}
                      onChange={(e) =>
                        updateMaterial(row.key, { unit: e.target.value })
                      }
                      placeholder="м, кг, шт"
                      maxLength={32}
                      style={{ width: 80 }}
                    />
                  </td>
                  <td className="num">
                    <input
                      name={`material[${row.key}][qtyPerUnit]`}
                      type="text"
                      inputMode="decimal"
                      value={row.qtyPerUnit}
                      onChange={(e) =>
                        updateMaterial(row.key, { qtyPerUnit: e.target.value })
                      }
                      placeholder="0.5"
                      style={{ width: 100, textAlign: 'right' }}
                    />
                  </td>
                  <td>
                    <input
                      name={`material[${row.key}][note]`}
                      type="text"
                      value={row.note}
                      onChange={(e) =>
                        updateMaterial(row.key, { note: e.target.value })
                      }
                      maxLength={500}
                      style={{ width: '100%' }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        setMaterials((p) =>
                          p.filter((r) => r.key !== row.key),
                        )
                      }
                      aria-label="Удалить строку"
                      title="Удалить"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <div
          className="meta-line"
          style={{
            marginBottom: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
          }}
        >
          <strong>
            Внешние потребности (подряд / OUTSOURCED_SERVICE)
          </strong>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setOutsource((p) => [...p, emptyOutsourceRow()])}
          >
            <Icon name="plus" size={14} />
            Добавить строку
          </button>
        </div>
        {outsource.length === 0 ? (
          <div className="meta-line" style={{ marginBottom: '0.5rem' }}>
            Пока нет строк внешних потребностей — добавьте при необходимости.
          </div>
        ) : (
          <table className="data-table" style={{ marginBottom: '0.5rem' }}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Единица</th>
                <th className="num">Норма / 1 шт</th>
                <th>Подрядчик</th>
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
                      placeholder="например, Шелкография"
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
                  <td className="num">
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
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        setOutsource((p) =>
                          p.filter((r) => r.key !== row.key),
                        )
                      }
                      aria-label="Удалить строку"
                      title="Удалить"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="detail-form__actions">
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
          {state.successMessage}
        </div>
      )}
    </form>
  );
}
