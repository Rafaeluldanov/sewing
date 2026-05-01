'use client';

/**
 * AdminSizeGrid — компактная сетка размеров для блока «План по размерам»
 * формы создания заказа и для read-only превью на `/admin/orders/[id]`.
 *
 * Контракт:
 *   - Никаких add/remove row — рендерим сразу весь переданный массив
 *     `sizes`. Источник правды по составу размеров остаётся за
 *     `Size`-справочником на бэкенде.
 *   - FormData-контракт не меняется: каждый input получает
 *     `name = `${namePrefix}[${size.id}]``. Дефолт `namePrefix = "qty"`
 *     даёт ровно те ключи, что читает `createOrderAction` в
 *     `apps/web/app/orders/actions.ts` (`qty[<sizeId>]`).
 *   - Input остаётся uncontrolled (`defaultValue`), чтобы форма
 *     продолжала работать без `useState` на каждый input. Поверх этого
 *     компонент держит у себя локальное состояние с текущими
 *     количествами — нужно для двух UX-фич:
 *       1) `admin-size-grid__item--active` — плитка подсвечивается,
 *          как только в input введено значение `> 0`;
 *       2) `onTotalChange` — родительская форма получает Σ(qty) и
 *          может показывать «Всего по плану N шт.», не дублируя
 *          DOM-чтение FormData.
 *   - Keyboard UX (только в редактируемом режиме):
 *       - `Enter`     — фокус переходит на следующий size-input;
 *       - `Shift+Enter` — на предыдущий;
 *       - форма по `Enter` внутри size-input не сабмитится
 *         (`preventDefault`).
 *   - `readOnly` режим обязательно сохранён — на нём держится
 *     карточка `/admin/orders/[id]`. В read-only выключаем и input,
 *     и onChange/onKeyDown, и подсветку (active класс не вешаем —
 *     readOnly-плитка показывает план, а не состояние ввода).
 *   - Корневой `<div>` помечен `data-size-grid="true"` — для smoke-
 *     тестов и e2e-локаторов.
 *
 * Контракт props см. `AdminSizeGridProps` ниже.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface AdminSizeGridSize {
  /** Стабильный id размера. Используется и в `key`, и в `name=qty[...]`. */
  id: string;
  /** Человеческое имя/код размера (S / M / 46 / …). */
  name: string;
}

export interface AdminSizeGridProps {
  sizes: readonly AdminSizeGridSize[];
  /**
   * Начальные значения по `sizeId`. Для редактируемого режима — это
   * `defaultValue` инпута; для read-only — отображаемое число.
   * `undefined` / отсутствие ключа трактуется как 0 (для read-only)
   * либо как пустое поле (для редактируемого режима).
   */
  values?: Record<string, number | null | undefined>;
  /**
   * Префикс FormData-имени. Имя итогового инпута:
   * `${namePrefix}[${sizeId}]`. По умолчанию `"qty"` — совпадает с
   * `createOrderAction`.
   */
  namePrefix?: string;
  /**
   * Read-only режим: input помечается `disabled`, под ним опционально
   * показывается «вторичная» цифра (например, факт кроя).
   */
  readOnly?: boolean;
  /**
   * Опциональная вторая величина по `sizeId` для read-only режима
   * (в карточке заказа — это `qtyCutFact`, чтобы менеджер сразу видел
   * `qtyCut / qtyPlan` без перехода в паспорта).
   */
  secondary?: Record<string, number | null | undefined>;
  /**
   * Подпись над вторичной величиной (по умолчанию «крой»).
   * Появляется только если `readOnly && secondary[size.id] != null`.
   */
  secondaryLabel?: ReactNode;
  /**
   * Префикс aria-label инпута. Итог: `${ariaLabelPrefix} ${size.name}`.
   * По умолчанию — «Количество для размера».
   */
  ariaLabelPrefix?: string;
  /** Дополнительный класс на корневой `<div>` (для кастомизации). */
  className?: string;
  /**
   * Колбэк суммы всех qty (`>0`). Срабатывает на mount и при каждом
   * изменении любого input. В read-only вызывается единожды на mount
   * с суммой переданных `values`. Использует `requestAnimationFrame`
   * — нет, обычный `useEffect`: вызовов мало, дешевле не городить.
   */
  onTotalChange?: (total: number) => void;
}

function toPositiveInt(input: string): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function AdminSizeGrid({
  sizes,
  values,
  namePrefix = 'qty',
  readOnly = false,
  secondary,
  secondaryLabel = 'крой',
  ariaLabelPrefix = 'Количество для размера',
  className,
  onTotalChange,
}: AdminSizeGridProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const initialQty = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    if (!values) return out;
    for (const size of sizes) {
      const raw = values[size.id];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        out[size.id] = raw;
      }
    }
    return out;
  }, [sizes, values]);

  const [qtyMap, setQtyMap] = useState<Record<string, number>>(initialQty);

  const total = useMemo(
    () => Object.values(qtyMap).reduce((sum, v) => sum + v, 0),
    [qtyMap],
  );

  useEffect(() => {
    if (onTotalChange) onTotalChange(total);
  }, [total, onTotalChange]);

  const handleChange = useCallback(
    (sizeId: string) => (e: ChangeEvent<HTMLInputElement>) => {
      const value = toPositiveInt(e.target.value);
      setQtyMap((prev) => {
        const wasActive = prev[sizeId] && prev[sizeId] > 0;
        if (value > 0) {
          if (prev[sizeId] === value) return prev;
          return { ...prev, [sizeId]: value };
        }
        if (!wasActive) return prev;
        const next = { ...prev };
        delete next[sizeId];
        return next;
      });
    },
    [],
  );

  const handleKeyDown = useCallback(
    (index: number) => (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      // Никогда не сабмитим форму по Enter внутри size-input — менеджер
      // вводит десятки полей подряд, случайный Enter ломает работу.
      e.preventDefault();
      const direction = e.shiftKey ? -1 : 1;
      const nextIdx = index + direction;
      const nextEl = inputRefs.current[nextIdx];
      if (nextEl && !nextEl.disabled) {
        nextEl.focus();
        nextEl.select();
      }
    },
    [],
  );

  const cls = ['admin-size-grid', className].filter(Boolean).join(' ');

  return (
    <div className={cls} data-size-grid="true">
      {sizes.map((size, idx) => {
        const raw = values?.[size.id];
        const planValue =
          typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
        const secondaryRaw = secondary?.[size.id];
        const secondaryValue =
          typeof secondaryRaw === 'number' && Number.isFinite(secondaryRaw)
            ? secondaryRaw
            : null;
        const isActive = !readOnly && (qtyMap[size.id] ?? 0) > 0;
        const itemCls =
          'admin-size-grid__item' +
          (isActive ? ' admin-size-grid__item--active' : '');
        return (
          <div key={size.id} className={itemCls}>
            <div className="admin-size-grid__label">{size.name}</div>
            <input
              ref={(el) => {
                inputRefs.current[idx] = el;
              }}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              name={`${namePrefix}[${size.id}]`}
              defaultValue={planValue ?? (readOnly ? 0 : '')}
              placeholder="0"
              disabled={readOnly}
              onChange={readOnly ? undefined : handleChange(size.id)}
              onKeyDown={readOnly ? undefined : handleKeyDown(idx)}
              aria-label={`${ariaLabelPrefix} ${size.name}`}
              className="admin-size-grid__input"
            />
            {readOnly && secondaryValue !== null && (
              <div className="admin-size-grid__secondary">
                <span className="admin-size-grid__secondary-label">
                  {secondaryLabel}
                </span>
                <span className="admin-size-grid__secondary-value">
                  {secondaryValue.toLocaleString('ru-RU')}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
