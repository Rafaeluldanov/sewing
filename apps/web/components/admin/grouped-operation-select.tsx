'use client';

/**
 * `GroupedOperationSelect` — нативный `<select>` со встроенным
 * `<optgroup>` по категориям операций.
 *
 * Назначение: один и тот же UX выбора операции на всех админ-формах
 * (см. ТЗ «Единая группировка операций и оборудования», §5).
 *
 * Контракт сознательно простой:
 *   - operations — плоский список (`OperationLiteDto`-shape без жёсткой
 *     привязки к DTO, чтобы переиспользовать на формах, где приходят
 *     уже отображаемые суммари);
 *   - порядок групп берётся из shared `groupOperationsByCategory` —
 *     `OPERATION_CATEGORY_ORDER`, потом `Без категории`;
 *   - внутри группы порядок входных операций сохраняется (внешний
 *     код может предварительно отсортировать по `sortOrder`).
 *
 * Никакой бизнес-логики и валидации: это только chrome нативного
 * `<select>` + `<optgroup>`, чтобы все экраны выглядели одинаково.
 *
 * Опциональный creatable-режим (контур ref-create): последним пунктом
 * рендерится «＋ Добавить операцию…», открывающий модалку создания.
 * Merge созданной операции — ответственность хоста
 * (`onCreatedOperation`): хост держит список в state и после merge
 * получает автовыбор через обычный `onChange`. Внутренних extra-опций,
 * как у `CreatableSelect`, здесь нет — хосты фильтруют список
 * (например, убирают уже привязанные операции), и «своя» опция
 * ломала бы эту фильтрацию.
 */
import { useId, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  groupOperationsByCategory,
  type GroupableOperation,
  type OperationDetailDto,
} from '@sewing/shared/operations';
import { CREATE_SENTINEL } from './ref-create/creatable-select';

const CreateOperationModal = dynamic(
  () =>
    import('./ref-create/create-operation-modal').then(
      (m) => m.CreateOperationModal,
    ),
  { ssr: false },
);

interface GroupedOperationSelectProps<T extends GroupableOperation> {
  operations: readonly T[];
  /** name атрибут для FormData (`name="operationId"` и пр.). */
  name: string;
  /** Текущее значение (id операции). */
  value?: string;
  /** Default value для неконтролируемых форм. */
  defaultValue?: string;
  /** id для связки с `<label htmlFor>`. */
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Лейбл первого «—» option. По умолчанию «— выбрать —». */
  placeholder?: string;
  /**
   * Если `false` — placeholder-option не рендерится. Полезно, когда
   * `required` и форма должна строго принять валидный id.
   */
  includePlaceholder?: boolean;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  /**
   * Опциональный кастомный лейбл для каждой операции в `<option>`.
   * По умолчанию — `op.name`. Например, форма может захотеть показать
   * «Оверлок · OVERLOCK», тогда передаёт `(op) => `${op.name} · ${op.code}``.
   */
  formatOption?: (op: T) => string;
  /** Включает пункт «＋ Добавить операцию…» в конце списка. */
  creatable?: boolean;
  /**
   * Созданная операция (полный DTO): хост мержит её в свой список
   * операций. Автовыбор придёт следом через `onChange(op.id)`.
   */
  onCreatedOperation?: (op: OperationDetailDto) => void;
  /** z-index модалки создания (для вложенных оверлеев). */
  modalZIndex?: number;
}

export function GroupedOperationSelect<T extends GroupableOperation>({
  operations,
  name,
  value,
  defaultValue,
  id,
  required,
  disabled,
  className,
  placeholder = '— выбрать —',
  includePlaceholder = true,
  onChange,
  ariaLabel,
  formatOption,
  creatable = false,
  onCreatedOperation,
  modalZIndex,
}: GroupedOperationSelectProps<T>) {
  const generatedId = useId();
  const selectId = id ?? `op-select-${generatedId}`;
  const [createOpen, setCreateOpen] = useState(false);
  /** Последнее «настоящее» значение — для отката sentinel в uncontrolled-режиме. */
  const lastValueRef = useRef(defaultValue ?? '');
  const groups = useMemo(
    () => groupOperationsByCategory(operations),
    [operations],
  );
  const selectProps = value !== undefined ? { value } : { defaultValue };

  return (
    <>
      <select
        id={selectId}
        name={name}
        required={required}
        disabled={disabled}
        className={className}
        aria-label={ariaLabel}
        onChange={(e) => {
          const next = e.target.value;
          if (creatable && next === CREATE_SENTINEL) {
            // Не пробрасываем sentinel хосту. Controlled-хост откатится
            // сам на ре-рендере; uncontrolled возвращаем руками.
            e.target.value =
              value !== undefined ? value : lastValueRef.current;
            setCreateOpen(true);
            return;
          }
          lastValueRef.current = next;
          onChange?.(next);
        }}
        {...selectProps}
      >
        {includePlaceholder && <option value="">{placeholder}</option>}
        {groups.map((group) => (
          <optgroup
            key={group.category}
            label={group.label}
            data-category={group.category}
          >
            {group.operations.map((op) => (
              <option key={op.id} value={op.id}>
                {formatOption ? formatOption(op) : op.name}
              </option>
            ))}
          </optgroup>
        ))}
        {creatable && (
          <option value={CREATE_SENTINEL}>＋ Добавить операцию…</option>
        )}
      </select>
      {createOpen && (
        <CreateOperationModal
          zIndex={modalZIndex}
          onCancel={() => setCreateOpen(false)}
          onCreated={(op) => {
            onCreatedOperation?.(op);
            onChange?.(op.id);
            setCreateOpen(false);
          }}
        />
      )}
    </>
  );
}
