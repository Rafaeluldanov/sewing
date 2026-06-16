/**
 * Комбобокс выбора техкарты с группировкой по группам номенклатуры
 * (этап «Техкарта папками по группе номенклатуры»).
 *
 * Зачем отдельный компонент, а не нативный `<select>` + `<optgroup>`:
 *   - менеджер открывает список и видит ПАПКИ (группы номенклатуры),
 *     папка по клику разворачивается и показывает техкарты внутри —
 *     `<optgroup>` так не умеет (заголовки всегда развёрнуты, без
 *     сворачивания, иконок и поиска);
 *   - сверху строка поиска: фильтрует техкарты по названию и
 *     авто-раскрывает папки с совпадениями.
 *
 * Связь техкарта → группа: `TechCardTemplate.patternCategoryId`
 * (nullable FK на `PatternCategory`, см. `prisma/schema.prisma`).
 * DTO `TechCardTemplateSummaryDto` уже несёт `patternCategoryId`,
 * группы (`PatternCategoryListItemDto`) грузятся на странице создания
 * заказа (`page.tsx`) — новых эндпоинтов не нужно.
 *
 * Источник правды по выбранному значению — родитель (`techCardId` /
 * `setTechCardId` в `admin-create-order-form.tsx`). Сюда оно приходит
 * как `value` / `onChange`, а в `<form>` уходит скрытым input-ом с тем
 * же `name="techCardId"`, что и старый select — server action
 * (`createOrderAction`) не меняется.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Search,
  X,
} from 'lucide-react';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import { resolvePatternCategoryIcon } from '@/lib/pattern-category-icon';

/**
 * Технический ключ бакета «Без группы» — техкарты с
 * `patternCategoryId == null` или указывающие на отсутствующую/архивную
 * группу (её нет в переданном списке активных категорий).
 */
const NO_GROUP_KEY = '__no_group__';

interface GroupNode {
  key: string;
  name: string;
  /** `iconKey` группы для иконки папки; `null` → дефолтная иконка. */
  iconKey: string | null;
  sortOrder: number;
  cards: TechCardTemplateSummaryDto[];
}

export interface TechCardComboboxProps {
  /** Имя поля в `<form>` — должно совпадать со старым select-ом. */
  name: string;
  value: string;
  onChange: (techCardId: string) => void;
  techCards: TechCardTemplateSummaryDto[];
  categories: PatternCategoryListItemDto[];
  id?: string;
}

export function TechCardCombobox({
  name,
  value,
  onChange,
  techCards,
  categories,
  id,
}: TechCardComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Раскрытые папки (по `key`). Поиск управляет раскрытием отдельно —
  // при непустом запросе все папки с совпадениями раскрыты принудительно.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  // Группировка техкарт по группе номенклатуры. Папки сортируем как в
  // каталоге: sortOrder ↑, затем имя; «Без группы» всегда последней.
  const groups = useMemo<GroupNode[]>(() => {
    const byKey = new Map<string, GroupNode>();
    for (const cat of categories) {
      byKey.set(cat.id, {
        key: cat.id,
        name: cat.name,
        iconKey: cat.iconKey ?? null,
        sortOrder: cat.sortOrder,
        cards: [],
      });
    }
    const noGroup: GroupNode = {
      key: NO_GROUP_KEY,
      name: 'Без группы',
      iconKey: null,
      sortOrder: Number.MAX_SAFE_INTEGER,
      cards: [],
    };
    for (const tc of techCards) {
      const node =
        (tc.patternCategoryId && byKey.get(tc.patternCategoryId)) || noGroup;
      node.cards.push(tc);
    }
    const result = [...byKey.values()].filter((g) => g.cards.length > 0);
    if (noGroup.cards.length > 0) result.push(noGroup);
    result.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'),
    );
    return result;
  }, [techCards, categories]);

  // Поиск по названию техкарты. Возвращает только папки с совпадениями
  // и сами совпавшие карты. Пустой запрос — все папки/карты.
  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = useMemo<GroupNode[]>(() => {
    if (normalizedQuery === '') return groups;
    return groups
      .map((g) => ({
        ...g,
        cards: g.cards.filter((c) =>
          c.name.toLowerCase().includes(normalizedQuery),
        ),
      }))
      .filter((g) => g.cards.length > 0);
  }, [groups, normalizedQuery]);

  const selectedCard = useMemo(
    () => techCards.find((c) => c.id === value) ?? null,
    [techCards, value],
  );

  // Закрытие по клику вне / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // При открытии: раскрываем папку с уже выбранной техкартой, чтобы её
  // было видно сразу.
  useEffect(() => {
    if (!open) return;
    if (selectedCard) {
      const key = selectedCard.patternCategoryId ?? NO_GROUP_KEY;
      setExpanded((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    }
  }, [open, selectedCard]);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function select(techCardId: string) {
    onChange(techCardId);
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="tc-combobox" ref={rootRef}>
      {/* Источник истины для server action — скрытый input с тем же
          name, что был у старого <select name="techCardId">. */}
      <input type="hidden" name={name} value={value} />

      <button
        type="button"
        id={id}
        className="tc-combobox__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={
            'tc-combobox__value' +
            (selectedCard ? '' : ' tc-combobox__value--placeholder')
          }
        >
          {selectedCard ? selectedCard.name : '— без техкарты —'}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={1.8}
          aria-hidden
          className="tc-combobox__caret"
        />
      </button>

      {open && (
        <div className="tc-combobox__panel" role="listbox">
          <div className="tc-combobox__search">
            <Search size={15} strokeWidth={1.8} aria-hidden />
            <input
              type="text"
              autoFocus
              value={query}
              placeholder="Поиск техкарты…"
              onChange={(e) => setQuery(e.target.value)}
              className="tc-combobox__search-input"
            />
            {query !== '' && (
              <button
                type="button"
                className="tc-combobox__search-clear"
                aria-label="Очистить поиск"
                onClick={() => setQuery('')}
              >
                <X size={14} strokeWidth={1.9} aria-hidden />
              </button>
            )}
          </div>

          <div className="tc-combobox__list">
            {/* «Без техкарты» — всегда доступная опция сброса. */}
            <button
              type="button"
              role="option"
              aria-selected={value === ''}
              className={
                'tc-combobox__card tc-combobox__card--reset' +
                (value === '' ? ' is-selected' : '')
              }
              onClick={() => select('')}
            >
              — без техкарты —
            </button>

            {visibleGroups.length === 0 ? (
              <div className="tc-combobox__empty">Ничего не найдено</div>
            ) : (
              visibleGroups.map((g) => {
                // При активном поиске папки раскрыты принудительно.
                const isOpen =
                  normalizedQuery !== '' || expanded.has(g.key);
                const FolderIcon = isOpen ? FolderOpen : Folder;
                const CatIcon =
                  g.key === NO_GROUP_KEY
                    ? null
                    : resolvePatternCategoryIcon(g.iconKey);
                return (
                  <div className="tc-combobox__group" key={g.key}>
                    <button
                      type="button"
                      className="tc-combobox__folder"
                      aria-expanded={isOpen}
                      onClick={() => toggleGroup(g.key)}
                    >
                      {isOpen ? (
                        <ChevronDown size={14} strokeWidth={1.9} aria-hidden />
                      ) : (
                        <ChevronRight size={14} strokeWidth={1.9} aria-hidden />
                      )}
                      {CatIcon ? (
                        <CatIcon
                          size={15}
                          strokeWidth={1.7}
                          aria-hidden
                          className="tc-combobox__folder-icon"
                        />
                      ) : (
                        <FolderIcon
                          size={15}
                          strokeWidth={1.7}
                          aria-hidden
                          className="tc-combobox__folder-icon"
                        />
                      )}
                      <span className="tc-combobox__folder-name">{g.name}</span>
                      <span className="tc-combobox__folder-count">
                        {g.cards.length}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="tc-combobox__cards">
                        {g.cards.map((tc) => (
                          <button
                            key={tc.id}
                            type="button"
                            role="option"
                            aria-selected={tc.id === value}
                            className={
                              'tc-combobox__card' +
                              (tc.id === value ? ' is-selected' : '')
                            }
                            onClick={() => select(tc.id)}
                          >
                            {tc.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
