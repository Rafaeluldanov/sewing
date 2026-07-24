'use client';

/**
 * `OrdersSearchInput` — «живой» (динамический) поиск по списку заказов
 * на `/admin/orders`. Раньше это был обычный `<input name="search">`
 * внутри GET-формы: искать можно было только после клика «Применить»,
 * и только по номеру заказа. Теперь поле ищет по мере ввода — уже с
 * первой буквы — и по любому текстовому параметру заказа (номер,
 * клиент/организация, подразделение, дата/срок; мультиполевой матч
 * делает backend, см. `OrdersService.list`).
 *
 * Как это работает (тот же приём, что у `PageSizeSelect`):
 *   - uncontrolled `<input defaultValue={initial}>` — компонент остаётся
 *     смонтированным при soft-навигации, поэтому фокус и каретка не
 *     теряются между перерисовками RSC (важно для набора «на лету»);
 *   - `onChange` дебаунсится (~300 мс) и через `router.replace` меняет
 *     `?search=…`, сбрасывая `page` в 1 и СОХРАНЯЯ остальные фильтры
 *     (`preserveParams`: статус, клиент, подразделение, срок, сортировка,
 *     размер страницы). `replace`, а не `push`, — чтобы набор текста не
 *     засорял историю браузера;
 *   - пустой ввод убирает параметр `search` целиком.
 *
 * Поле по-прежнему живёт внутри `<form method="get">` и сохраняет
 * `name="search"`, поэтому Enter / кнопка «Применить» работают как
 * фолбэк (в т.ч. без JS) — контракт не ломается.
 */
import { useRef } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  /** Текущее значение поиска (из `searchParams.search`). */
  initial: string;
  /** База пути списка, например `/admin/orders`. */
  basePath: string;
  /**
   * Прочие активные фильтры, которые нужно сохранить при навигации.
   * `search` и `page` сюда НЕ входят — их выставляет сам компонент.
   */
  preserveParams: Record<string, string | undefined>;
  /** Задержка дебаунса, мс. По умолчанию 300. */
  debounceMs?: number;
}

export function OrdersSearchInput({
  initial,
  basePath,
  preserveParams,
  debounceMs = 300,
}: Props) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function navigate(raw: string) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(preserveParams)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
    const search = raw.trim();
    if (search.length > 0) params.set('search', search);
    // Любая смена поиска возвращает пагинацию на первую страницу.
    params.set('page', '1');
    const qs = params.toString();
    router.replace(qs.length > 0 ? `${basePath}?${qs}` : basePath);
  }

  return (
    <div className="admin-field">
      <label htmlFor="orders-search">Поиск</label>
      <input
        id="orders-search"
        name="search"
        type="search"
        placeholder="Номер, клиент, подразделение, дата…"
        defaultValue={initial}
        autoComplete="off"
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => navigate(value), debounceMs);
        }}
      />
    </div>
  );
}
