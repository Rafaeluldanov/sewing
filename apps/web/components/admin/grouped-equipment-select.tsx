'use client';

/**
 * `GroupedEquipmentSelect` — нативный `<select>` со встроенным
 * `<optgroup>` по primary-категории связанных операций оборудования.
 *
 * Назначение: один и тот же UX выбора оборудования на админ-формах
 * (см. ТЗ «Единая группировка операций и оборудования», §7).
 *
 * UX-логика (см. ТЗ §6/§7):
 *   - оборудование показывается ровно один раз в primary-группе по
 *     `getPrimaryEquipmentCategory` — без дублирования по группам;
 *   - оборудование без операций уходит в группу «Без операций» в конце;
 *   - если контекст известен (`categoryFilter`), оставляем только
 *     оборудование с этой категорией среди operations — остальные
 *     группы скрыты целиком (UX «выбор только релевантного»).
 *
 * Контракт намеренно не привязан к конкретному DTO: компонент берёт
 * `id`, `name` и опциональный `operations: [{ category }]` — это
 * совместимо и с EquipmentSummaryDto (через `operationCategories`),
 * и с EquipmentDetailDto (через `allowedOperations`).
 */
import { useId, useMemo } from 'react';
import {
  groupEquipmentByOperationCategory,
  type GroupableEquipment,
  type OperationCategory,
} from '@sewing/shared/operations';

interface GroupedEquipmentSelectProps<T extends GroupableEquipment> {
  equipment: readonly T[];
  /** name атрибут для FormData (`name="equipmentId"` и пр.). */
  name: string;
  value?: string;
  defaultValue?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  includePlaceholder?: boolean;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  /**
   * Если задано, в селекте остаётся только оборудование, у которого
   * среди операций есть указанная категория. Используется на рабочих
   * экранах, где известна нужная операция/категория и не нужно
   * показывать ВСЁ оборудование цеха.
   */
  categoryFilter?: OperationCategory;
  /** Кастомный лейбл `<option>`. По умолчанию — `eq.name`. */
  formatOption?: (eq: T) => string;
}

export function GroupedEquipmentSelect<T extends GroupableEquipment>({
  equipment,
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
  categoryFilter,
  formatOption,
}: GroupedEquipmentSelectProps<T>) {
  const generatedId = useId();
  const selectId = id ?? `eq-select-${generatedId}`;
  const filtered = useMemo(() => {
    if (!categoryFilter) return [...equipment];
    return equipment.filter((eq) =>
      (eq.operations ?? []).some((op) => op.category === categoryFilter),
    );
  }, [equipment, categoryFilter]);
  const groups = useMemo(
    () => groupEquipmentByOperationCategory(filtered),
    [filtered],
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
          {group.equipment.map((eq) => (
            <option key={eq.id} value={eq.id}>
              {formatOption ? formatOption(eq) : eq.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
