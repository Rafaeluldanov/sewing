'use client';

/**
 * Поисковый combobox для фильтров отчёта «Себестоимость» (лекало / заказ /
 * клиент / сотрудник / операция).
 *
 * Показывает человекочитаемые названия с поиском по подстроке, а в форму
 * (`method=get`) кладёт выбранный `id` через скрытый `<input name=...>`.
 * Поддержка клавиатуры: ↑/↓ — навигация, Enter — выбор, Esc — закрыть.
 * Источник вариантов — `GET /api/admin/production-cost/v2/filter-options`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ProductionCostFilterOptionDto } from '@sewing/shared/production-cost';

interface FilterComboboxProps {
  /** Имя поля формы (например, `patternItemId`). В него уходит выбранный id. */
  name: string;
  label: string;
  placeholder?: string;
  options: ProductionCostFilterOptionDto[];
  /** Текущий выбранный id (из query string). */
  defaultValue?: string;
}

function optionText(o: ProductionCostFilterOptionDto): string {
  return o.sublabel ? `${o.label} — ${o.sublabel}` : o.label;
}

export function FilterCombobox({
  name,
  label,
  placeholder,
  options,
  defaultValue,
}: FilterComboboxProps) {
  const initial = options.find((o) => o.id === defaultValue) ?? null;
  const [selected, setSelected] =
    useState<ProductionCostFilterOptionDto | null>(initial);
  const [query, setQuery] = useState(initial ? optionText(initial) : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Клик вне компонента — закрыть и вернуть в поле подпись выбранного
  // (чтобы недонабранный запрос не «висел»).
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selected ? optionText(selected) : '');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || (selected && q === optionText(selected).toLowerCase())) {
      return options.slice(0, 200);
    }
    return options
      .filter((o) => optionText(o).toLowerCase().includes(q))
      .slice(0, 200);
  }, [query, options, selected]);

  function choose(opt: ProductionCostFilterOptionDto) {
    setSelected(opt);
    setQuery(optionText(opt));
    setOpen(false);
  }
  function clear() {
    setSelected(null);
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="cost-combo" ref={rootRef}>
      <input type="hidden" name={name} value={selected?.id ?? ''} />
      <div className="cost-combo__control">
        <input
          type="text"
          value={query}
          placeholder={placeholder ?? label}
          autoComplete="off"
          aria-label={label}
          role="combobox"
          aria-expanded={open}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            const v = e.target.value;
            setQuery(v);
            setOpen(true);
            setActive(0);
            if (selected && v !== optionText(selected)) setSelected(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              if (open && filtered[active]) {
                e.preventDefault();
                choose(filtered[active]);
              }
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          style={{ paddingRight: selected ? 28 : undefined }}
        />
        {selected && (
          <button
            type="button"
            className="cost-combo__clear"
            onClick={clear}
            aria-label={`Очистить «${label}»`}
          >
            <X size={14} strokeWidth={1.8} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <div className="cost-combo__menu" role="listbox" aria-label={label}>
          {filtered.length === 0 ? (
            <div className="cost-combo__empty">Ничего не найдено</div>
          ) : (
            filtered.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={selected?.id === o.id}
                data-active={i === active ? 'true' : undefined}
                className="cost-combo__option"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                <span>{o.label}</span>
                {o.sublabel ? (
                  <span className="cost-combo__option-sub">{o.sublabel}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
