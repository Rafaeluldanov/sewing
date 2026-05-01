'use client';

/**
 * AdminDateField — единый «красивый» date picker для админки.
 *
 * Дизайн (см. задачу «Доработать заказы и даты»):
 *   - снаружи это обычный `<input type="date">` с заданным `name`,
 *     поэтому `FormData` собирается ровно так же, как раньше — это
 *     гарантирует backward compatibility с server actions
 *     (`apps/web/app/orders/actions.ts`,
 *     `apps/web/app/admin/clients/actions.ts`, …);
 *   - справа — иконка `Calendar` из `lucide-react`. Клик по иконке
 *     зовёт `input.showPicker()` (поддерживается Chromium/Edge,
 *     Firefox 101+, Safari 17+); если метод недоступен — fallback
 *     на `input.focus()`, чтобы хотя бы открылся курсор и можно
 *     было набрать дату с клавиатуры или открыть picker системной
 *     раскладкой;
 *   - визуальный стиль совпадает с прочими `.admin-field > input`:
 *     светлый фон, `1px solid var(--admin-border)`, `radius 14px`,
 *     focus подсвечен `--admin-primary`. Отдельный класс
 *     `admin-date-field` — чтобы прятать нативную иконку календаря у
 *     браузеров, у которых она встроена (Chromium показывает свою
 *     серую — она дублирует наш `Calendar` и выглядит шумно).
 *
 * Используется как контролируемый, так и uncontrolled input: пробрасываем
 * `value`/`defaultValue`/`onChange`. Никакого state-менеджмента
 * внутри — компонент должен жить на серверных формах без shenanigans.
 */
import { useRef, type ChangeEvent, type Ref } from 'react';
import { Calendar } from 'lucide-react';

export interface AdminDateFieldProps {
  /**
   * `name` для FormData. Должен совпадать с тем, что читает соответствующий
   * server action (`orderDate`, `dueDate`, …).
   */
  name?: string;
  id?: string;
  /** Начальное значение в формате `YYYY-MM-DD` (uncontrolled). */
  defaultValue?: string;
  /** Текущее значение в формате `YYYY-MM-DD` (controlled). */
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  /** Для тестов — ref на сам `<input>`. */
  inputRef?: Ref<HTMLInputElement>;
}

export function AdminDateField({
  name,
  id,
  defaultValue,
  value,
  onChange,
  required,
  disabled,
  min,
  max,
  placeholder,
  ariaLabel,
  className,
  inputRef,
}: AdminDateFieldProps) {
  const innerRef = useRef<HTMLInputElement | null>(null);

  function setRefs(node: HTMLInputElement | null) {
    innerRef.current = node;
    if (typeof inputRef === 'function') {
      inputRef(node);
    } else if (inputRef && 'current' in inputRef) {
      (inputRef as { current: HTMLInputElement | null }).current = node;
    }
  }

  function openPicker() {
    const el = innerRef.current;
    if (!el || disabled) return;
    // showPicker — современный API браузеров (Chromium/Edge,
    // Firefox 101+, Safari 17+). Если его нет — focus() хотя бы
    // подсветит поле и даст системе шанс открыть picker сама.
    const maybeShowPicker = (el as HTMLInputElement & {
      showPicker?: () => void;
    }).showPicker;
    try {
      if (typeof maybeShowPicker === 'function') {
        maybeShowPicker.call(el);
        return;
      }
    } catch {
      // showPicker может бросить SecurityError, если вызван не из
      // user-gesture (на iOS Safari, например). В этом случае мягко
      // деградируем до focus().
    }
    el.focus();
  }

  return (
    <span
      className={
        'admin-date-field' + (className ? ` ${className}` : '')
      }
      data-disabled={disabled ? 'true' : undefined}
    >
      <input
        ref={setRefs}
        className="admin-date-field__input"
        type="date"
        name={name}
        id={id}
        defaultValue={defaultValue}
        value={value}
        onChange={onChange}
        required={required}
        disabled={disabled}
        min={min}
        max={max}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        className="admin-date-field__button"
        onClick={openPicker}
        disabled={disabled}
        aria-label="Открыть календарь"
        tabIndex={-1}
      >
        <Calendar size={18} strokeWidth={1.6} aria-hidden />
      </button>
    </span>
  );
}
