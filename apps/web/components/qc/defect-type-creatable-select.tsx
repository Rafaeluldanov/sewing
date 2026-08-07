'use client';

import { useState, type ChangeEvent } from 'react';
import type { DefectTypeDto } from '@sewing/shared/qc';
import { CREATE_SENTINEL } from '@/components/admin/ref-create/creatable-select';
import { createDefectTypeInlineAction } from './defect-type-actions';

/**
 * Select вида брака с пунктом «＋ Добавить вид брака…» в конце списка —
 * цеховой вариант контура ref-create (ОТК-карточка, страница паспорта
 * ОТК, шит мастера). Вместо admin-модалки — компактная inline-форма
 * прямо под селектом: цеховые экраны сами живут в шитах/карточках, и
 * ещё один overlay поверх них — UX-ловушка.
 *
 * Компонент сам рендерит опции (все три места показывают
 * «{name} · {code}») и держит созданные виды в локальном state.
 * Код вида не спрашиваем — backend подберёт свободный `DT-N`.
 *
 * Режимы — как у `CreatableSelect`: controlled (`value` +
 * `onValueChange`) или uncontrolled (`name` + `defaultValue`, значение
 * ведётся внутренним state и попадает в FormData).
 */
export function DefectTypeCreatableSelect({
  defectTypes,
  id,
  name,
  required,
  disabled = false,
  className,
  value,
  onValueChange,
  defaultValue = '',
  disableCreate = false,
}: {
  defectTypes: readonly DefectTypeDto[];
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  value?: string;
  onValueChange?: (next: string) => void;
  defaultValue?: string;
  disableCreate?: boolean;
}) {
  const controlled = value !== undefined;
  const [innerValue, setInnerValue] = useState(defaultValue);
  const [extraTypes, setExtraTypes] = useState<DefectTypeDto[]>([]);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allTypes = [
    ...defectTypes,
    ...extraTypes.filter((x) => !defectTypes.some((d) => d.id === x.id)),
  ];

  function handleChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (next === CREATE_SENTINEL) {
      setCreatorOpen(true);
      return;
    }
    if (!controlled) setInnerValue(next);
    onValueChange?.(next);
  }

  async function submitCreate() {
    setError(null);
    setSubmitting(true);
    const result = await createDefectTypeInlineAction({ name: newName });
    setSubmitting(false);
    if (!result.ok || !result.defectType) {
      setError(result.error ?? 'Не удалось создать вид брака');
      return;
    }
    const created = result.defectType;
    setExtraTypes((prev) => [...prev.filter((x) => x.id !== created.id), created]);
    if (!controlled) setInnerValue(created.id);
    onValueChange?.(created.id);
    setNewName('');
    setCreatorOpen(false);
  }

  return (
    <>
      <select
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        className={className}
        value={controlled ? value : innerValue}
        onChange={handleChange}
      >
        <option value="">— выбрать —</option>
        {allTypes.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} · {d.code}
          </option>
        ))}
        {!disableCreate && (
          <option value={CREATE_SENTINEL}>＋ Добавить вид брака…</option>
        )}
      </select>
      {creatorOpen && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
            marginTop: 6,
          }}
        >
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={120}
            placeholder="Название вида брака"
            disabled={submitting}
            autoFocus
            style={{ flex: '1 1 160px', minWidth: 0 }}
            onKeyDown={(e) => {
              // Enter не должен сабмитить внешнюю форму фиксации брака.
              if (e.key === 'Enter') {
                e.preventDefault();
                if (newName.trim() && !submitting) void submitCreate();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submitCreate()}
            disabled={submitting || newName.trim() === ''}
          >
            {submitting ? 'Добавление…' : 'Добавить'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setCreatorOpen(false);
              setNewName('');
              setError(null);
            }}
            disabled={submitting}
          >
            Отмена
          </button>
          {error && (
            <span role="alert" style={{ color: '#dc2626', fontSize: '0.82rem' }}>
              {error}
            </span>
          )}
        </div>
      )}
    </>
  );
}
