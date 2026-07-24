'use client';

/**
 * `AdminSearchInput` — переиспользуемое поле «живого» (динамического)
 * поиска по спискам админки. Ищет по мере ввода — уже с первой буквы —
 * без клика по кнопке «Найти»/«Применить».
 *
 * Единый примитив вместо копипасты: раньше на каждой странице был
 * обычный `<input name="search">` внутри `<form method="get">`, и поиск
 * срабатывал только после submit-а. Этот компонент оставляет то же
 * поле в той же форме (с тем же `name`), но дополнительно меняет URL по
 * ходу набора. Разворачивается на все списки (`/admin/orders`,
 * `/admin/clients`, `/admin/suppliers`, `/admin/purchase-orders`, …).
 *
 * Как работает (тот же приём, что у `PageSizeSelect`):
 *   - uncontrolled `<input defaultValue={initial}>` — компонент остаётся
 *     смонтированным при soft-навигации, поэтому фокус и каретка не
 *     теряются между перерисовками RSC (критично для набора «на лету»);
 *   - `onChange` дебаунсится (~300 мс) и через `router.replace` меняет
 *     `?<paramName>=…`, СОХРАНЯЯ остальные фильтры (`preserveParams`) и
 *     выставляя `resetParams` (сброс пагинации: `{ page: '1' }` для
 *     `AdminPagination`, `{ offset: '0' }` для складских списков);
 *   - пустой ввод убирает параметр поиска целиком;
 *   - `replace`, а не `push`, — чтобы набор не засорял историю браузера.
 *
 * Внешний сброс (`initial` изменился НЕ нашей навигацией — например
 * клик по ссылке «Сбросить» очистил URL): синхронизируем DOM-значение
 * поля через `ref`, но только когда `initial` расходится с тем, что мы
 * сами в последний раз отправили (`lastNavigated`). Это гасит гонку
 * «RSC вернул устаревший `initial`, пока пользователь допечатывает».
 *
 * Поле остаётся внутри `<form method="get">` с прежним `name`, поэтому
 * Enter / кнопка submit работают как фолбэк (в т.ч. без JS).
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  /** Текущее значение поиска (из `searchParams`). */
  initial: string;
  /** База пути списка, например `/admin/suppliers`. */
  basePath: string;
  /** Имя query-параметра поиска. По умолчанию `search`. */
  paramName?: string;
  /**
   * Прочие активные фильтры, которые нужно сохранить при навигации.
   * Параметр поиска и `resetParams` сюда НЕ входят.
   */
  preserveParams: Record<string, string | undefined>;
  /**
   * Параметры, выставляемые при КАЖДОЙ смене поиска (сброс пагинации).
   * По умолчанию `{ page: '1' }`. Для складских списков — `{ offset: '0' }`,
   * для списков без пагинации — `{}`.
   */
  resetParams?: Record<string, string>;
  /** Подпись поля. По умолчанию «Поиск». `null` — рендерим без `<label>`. */
  label?: string | null;
  placeholder?: string;
  /** id инпута (для `label htmlFor`). */
  id?: string;
  /** class на сам `<input>` (для нестандартной вёрстки, напр. `.toolbar`). */
  inputClassName?: string;
  /** class на обёртку поля. По умолчанию `admin-field`. `null` — без обёртки. */
  fieldClassName?: string | null;
  /** Задержка дебаунса, мс. По умолчанию 300. */
  debounceMs?: number;
}

export function AdminSearchInput({
  initial,
  basePath,
  paramName = 'search',
  preserveParams,
  resetParams = { page: '1' },
  label = 'Поиск',
  placeholder,
  id,
  inputClassName,
  fieldClassName = 'admin-field',
  debounceMs = 300,
}: Props) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Последнее значение, которое МЫ сами отправили в URL. Нужен, чтобы
  // отличать «наш» апдейт от внешнего сброса (см. useEffect ниже).
  const lastNavigated = useRef(initial);

  function navigate(raw: string) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(preserveParams)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
    const value = raw.trim();
    if (value.length > 0) params.set(paramName, value);
    // Сброс пагинации применяем поверх сохранённых параметров.
    for (const [k, v] of Object.entries(resetParams)) params.set(k, v);
    lastNavigated.current = value;
    const qs = params.toString();
    router.replace(qs.length > 0 ? `${basePath}?${qs}` : basePath);
  }

  // Внешняя навигация изменила `initial` (например «Сбросить» очистил
  // URL). Синхронизируем поле, но НЕ трогаем, если это отголосок нашей
  // же навигации (`initial === lastNavigated`) — иначе затрём то, что
  // пользователь успел допечатать.
  useEffect(() => {
    if (initial === lastNavigated.current) return;
    lastNavigated.current = initial;
    if (inputRef.current && inputRef.current.value !== initial) {
      inputRef.current.value = initial;
    }
  }, [initial]);

  const input = (
    <input
      ref={inputRef}
      id={id}
      name={paramName}
      type="search"
      className={inputClassName}
      placeholder={placeholder}
      defaultValue={initial}
      autoComplete="off"
      onChange={(e) => {
        const value = e.currentTarget.value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => navigate(value), debounceMs);
      }}
    />
  );

  if (!fieldClassName) return input;

  return (
    <div className={fieldClassName}>
      {label && <label htmlFor={id}>{label}</label>}
      {input}
    </div>
  );
}
