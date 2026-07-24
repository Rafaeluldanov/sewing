'use client';

/**
 * Клиентское тело `AdminTable`: рисует `<table>` и добавляет сортировку
 * по клику на заголовок колонки. Вынесено в отдельный клиентский
 * компонент, потому что `AdminTable` — серверный (страницы `/admin`
 * рендерят его внутри RSC), а сортировка требует состояния в браузере.
 *
 * Как это работает без правки 20+ мест вызова:
 *   - сервер (`AdminTable`) рендерит ячейки в готовые `<td>` и передаёт
 *     их сюда как `rows[].cells` (обычный проброс React-нод через границу
 *     server→client);
 *   - клик по заголовку читает `textContent` соответствующих ячеек прямо
 *     из DOM (в текущем порядке отображения) и переставляет `order` —
 *     массив исходных индексов. React владеет порядком (ключи строк
 *     стабильны), поэтому DOM не рассинхронизируется при ре-рендере.
 *
 * Тип значения определяется автоматически: `дд.мм.гггг` → дата, ru-число
 * (пробелы-разделители, запятая-десятичная, валюта обрезается) → число,
 * иначе — строковое `localeCompare('ru', { numeric })`. Пустые ячейки
 * («—») всегда падают вниз. Колонки `isAction` не сортируются.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { AdminTableRow } from './admin-table-row';

export interface AdminTableColumnMeta {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right' | 'center';
  isAction: boolean;
  sortable: boolean;
}

export interface AdminTableBodyRow {
  key: string;
  href: string | null;
  cells: ReactNode[];
}

interface SortState {
  col: number;
  dir: 'asc' | 'desc';
}

export function AdminTableView({
  columns,
  rows,
  className,
}: {
  columns: AdminTableColumnMeta[];
  rows: AdminTableBodyRow[];
  className?: string;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [order, setOrder] = useState<number[]>(() => rows.map((_, i) => i));
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // Выдача с сервера сменилась (пагинация / фильтр / поиск) — сбрасываем
  // сортировку и порядок к исходному. Ключ строим из ключей строк: он
  // меняется вместе с данными, но не при пустых ре-рендерах.
  const rowsKey = useMemo(() => rows.map((r) => r.key).join('|'), [rows]);
  useEffect(() => {
    setOrder(rows.map((_, i) => i));
    setSort(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey]);

  function handleSort(colIndex: number) {
    const tbody = tbodyRef.current;
    if (!tbody) return;

    // Читаем текст ячеек в ТЕКУЩЕМ порядке отображения — он совпадает с
    // `order` (позиция p в DOM ↔ order[p] — исходный индекс строки).
    const domRows = Array.from(tbody.rows);
    const valueByPos = order.map((_, pos) => {
      const cell = domRows[pos]?.cells[colIndex];
      return (cell?.textContent ?? '').trim();
    });

    // Тот же столбец: asc → desc → сброс. Другой столбец: сразу asc.
    let dir: 'asc' | 'desc' | null;
    if (sort?.col === colIndex) {
      dir = sort.dir === 'asc' ? 'desc' : null;
    } else {
      dir = 'asc';
    }
    if (dir === null) {
      setOrder(rows.map((_, i) => i));
      setSort(null);
      return;
    }

    const mul = dir === 'asc' ? 1 : -1;
    const pairs = order.map((origIdx, pos) => ({ origIdx, v: valueByPos[pos] }));
    pairs.sort((a, b) => {
      const ea = isEmptyCell(a.v);
      const eb = isEmptyCell(b.v);
      if (ea && eb) return 0;
      if (ea) return 1; // пустые всегда снизу, независимо от направления
      if (eb) return -1;
      return compareCells(a.v, b.v) * mul;
    });
    setOrder(pairs.map((p) => p.origIdx));
    setSort({ col: colIndex, dir });
  }

  return (
    <div className={['admin-table-wrap', className].filter(Boolean).join(' ')}>
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((c, i) => {
              const active = sort?.col === i ? sort.dir : null;
              const style: CSSProperties | undefined = c.align
                ? { textAlign: c.align }
                : undefined;
              const ariaSort = active
                ? active === 'asc'
                  ? 'ascending'
                  : 'descending'
                : c.sortable
                  ? 'none'
                  : undefined;
              return (
                <th key={c.key} style={style} aria-sort={ariaSort}>
                  {c.sortable ? (
                    <button
                      type="button"
                      className={`admin-table__sort${
                        active ? ' admin-table__sort--active' : ''
                      }`}
                      onClick={() => handleSort(i)}
                    >
                      <span>{c.header}</span>
                      {active === 'asc' ? (
                        <ArrowUp size={13} strokeWidth={2} aria-hidden />
                      ) : active === 'desc' ? (
                        <ArrowDown size={13} strokeWidth={2} aria-hidden />
                      ) : (
                        <ChevronsUpDown
                          size={13}
                          strokeWidth={1.6}
                          aria-hidden
                          className="admin-table__sort-idle"
                        />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={tbodyRef}>
          {order.map((i) => {
            const r = rows[i];
            if (r.href) {
              return (
                <AdminTableRow
                  key={r.key}
                  href={r.href}
                  className="admin-table__row--clickable"
                >
                  {r.cells}
                </AdminTableRow>
              );
            }
            return <tr key={r.key}>{r.cells}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function isEmptyCell(s: string): boolean {
  return s === '' || s === '—' || s === '-';
}

/** `дд.мм.гггг` → сравнимое число `ггггммдд`, иначе null. */
function toDateKey(s: string): number | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (!m) return null;
  return Number(`${m[3]}${m[2]}${m[1]}`);
}

/**
 * ru-число → number: пробелы/nbsp — разделители тысяч, запятая —
 * десятичная, валюта/единицы обрезаются. Дефис/буквы внутри (номера,
 * коды) → не число (null) — такие поля сортируются как строки.
 */
function toNumber(s: string): number | null {
  // `\s` в JS покрывает и nbsp (U+00A0), и узкий/тонкий пробел (U+202F/2009)
  // — это категория Zs, поэтому отдельных литералов не нужно.
  const cleaned = s
    .replace(/\s/g, '')
    .replace(/,/g, '.')
    .replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function compareCells(a: string, b: string): number {
  const da = toDateKey(a);
  const db = toDateKey(b);
  if (da !== null && db !== null) return da - db;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}
