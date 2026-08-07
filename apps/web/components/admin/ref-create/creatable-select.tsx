'use client';

import {
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { REF_CREATE_REGISTRY, type RefOption } from './registry';
import type {
  RefCreateContext,
  RefCreatedDtoMap,
  RefEntityKind,
} from './types';

/**
 * Sentinel-значение пункта «＋ Добавить…» в конце списка. Никогда не
 * «выбирается» по-настоящему: onChange перехватывает его ДО обновления
 * state, поэтому select визуально остаётся на прежнем значении, а
 * вместо выбора открывается модалка создания.
 */
export const CREATE_SENTINEL = '__create__';

export interface CreatableSelectProps<K extends RefEntityKind> {
  entity: K;
  /** Существующие `<option>`/`<optgroup>` хоста — рендерятся как есть. */
  children: ReactNode;
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  'aria-required'?: boolean | 'true' | 'false';
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
  'data-testid'?: string;
  /**
   * Controlled-режим: хост держит значение сам и получает новые значения
   * через `onValueChange` (в т.ч. id только что созданного элемента).
   */
  value?: string;
  onValueChange?: (next: string) => void;
  /** Uncontrolled-режим (формы на FormData): начальное значение. */
  defaultValue?: string;
  /**
   * Хук для хоста: созданный DTO целиком (обновить свой список,
   * дозагрузить связанное). Автовыбор значения происходит и без него.
   */
  onCreated?: (dto: RefCreatedDtoMap[K]) => void;
  /**
   * id (values) опций, которые хост уже рендерит в children. Нужен для
   * дедупа: когда хост после `onCreated` мержит элемент в свой список,
   * внутренняя extra-опция с тем же value самоустраняется.
   */
  existingValues?: readonly string[];
  /** Переопределить подпись пункта создания. */
  createLabel?: string;
  /** Контекст создания (ячейки склада: warehouseId + lock). */
  createContext?: RefCreateContext;
  /** Поверх вложенных оверлеев (`spr-overlay` = 1000, `qr-modal` = 100). */
  modalZIndex?: number;
  /** Спрятать пункт «＋ Добавить…» (терминальный режим, нет прав и т.п.). */
  disableCreate?: boolean;
}

/**
 * CreatableSelect — нативный `<select>` с последним пунктом
 * «＋ Добавить…», открывающим модалку создания справочной записи без
 * ухода со страницы. Созданный элемент сразу появляется в списке
 * (extra-опции после children) и выбирается автоматически.
 *
 * Обобщение прецедента из формы создания заказа
 * (`create-product-inline.tsx` + `create-*-window.tsx` +
 * `inline-product-actions.ts`). Модалки и маппинг DTO→option — в
 * `./registry.tsx`, серверные actions — в `./actions.ts`.
 *
 * Select внутри ВСЕГДА controlled: в controlled-режиме — от `value`
 * хоста, в uncontrolled — от внутреннего state, посеянного
 * `defaultValue` (controlled `<select name>` так же попадает в
 * FormData, хост-форма разницы не видит).
 */
export function CreatableSelect<K extends RefEntityKind>({
  entity,
  children,
  id,
  name,
  required,
  disabled,
  className,
  style,
  'aria-label': ariaLabel,
  'aria-required': ariaRequired,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'data-testid': dataTestId,
  value,
  onValueChange,
  defaultValue,
  onCreated,
  existingValues,
  createLabel,
  createContext,
  modalZIndex,
  disableCreate = false,
}: CreatableSelectProps<K>) {
  const controlled = value !== undefined;
  const [innerValue, setInnerValue] = useState(defaultValue ?? '');
  const [extraOptions, setExtraOptions] = useState<RefOption[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  const entry = REF_CREATE_REGISTRY[entity];
  const renderValue = controlled ? value : innerValue;
  const visibleExtra = extraOptions.filter(
    (o) => !existingValues?.includes(o.value),
  );

  function handleChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (next === CREATE_SENTINEL) {
      // Не трогаем state и не зовём хоста: на ре-рендере React вернёт
      // select-у прежнее значение, а мы откроем модалку.
      setModalOpen(true);
      return;
    }
    if (!controlled) setInnerValue(next);
    onValueChange?.(next);
  }

  function handleCreated(dto: RefCreatedDtoMap[K]) {
    const opts = entry.toOptions(dto);
    if (opts.length > 0) {
      const newIds = new Set(opts.map((o) => o.value));
      setExtraOptions((prev) => [
        ...prev.filter((o) => !newIds.has(o.value)),
        ...opts,
      ]);
      const nextValue = opts[0].value;
      if (!controlled) setInnerValue(nextValue);
      onValueChange?.(nextValue);
    }
    onCreated?.(dto);
    setModalOpen(false);
  }

  const Modal = entry.Modal;

  return (
    <>
      <select
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        className={className}
        style={style}
        aria-label={ariaLabel}
        aria-required={ariaRequired}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
        value={renderValue}
        onChange={handleChange}
      >
        {children}
        {visibleExtra.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {!disableCreate && (
          <option value={CREATE_SENTINEL}>
            {createLabel ?? entry.createLabel}
          </option>
        )}
      </select>
      {modalOpen && (
        <Modal
          context={createContext}
          zIndex={modalZIndex}
          onCancel={() => setModalOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
