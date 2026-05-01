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
 */
import { useId, useMemo } from 'react';
import {
  groupOperationsByCategory,
  type GroupableOperation,
} from '@sewing/shared/operations';

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
}: GroupedOperationSelectProps<T>) {
  const generatedId = useId();
  const selectId = id ?? `op-select-${generatedId}`;
  const groups = useMemo(
    () => groupOperationsByCategory(operations),
    [operations],
  );
  const selectProps = value !== undefined ? { value } : { defaultValue };

  return (
    <select
      id={selectId}
      name={name}
      required={required}
      disabled={disabled}
      className={className}
      aria-label={ariaLabel}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
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
    </select>
  );
}
