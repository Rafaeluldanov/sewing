/**
 * AdminTable — облегчённая таблица для админских списков.
 *
 * Отличия от старой `.data-table`:
 *   - меньше границ (борд только сверху строки, без рамок-сетки);
 *   - заголовки в SHOUTY MUTED стиле (uppercase, маленькие);
 *   - закруглённые углы и общий border-radius у обёртки;
 *   - на мобильном автоматически коллапсируется в карточки благодаря
 *     `data-label` (см. `globals.css`, `@media (max-width: 720px)`).
 *
 * Колонки описываются массивом — это нужно, чтобы:
 *   - на мобиле `data-label` подставлялся автоматически из `header`;
 *   - была одна точка правды для align/width;
 *   - smoke-тест мог проверить «нет колонки `code`», просто посмотрев
 *     на исходник страницы.
 *
 * Сортировка. Сам `AdminTable` серверный: он лишь рендерит ячейки в
 * готовые `<td>` и передаёт их в клиентский `AdminTableView`, который
 * добавляет клик-сортировку по заголовкам (по умолчанию сортируемы все
 * колонки, кроме `isAction`; отключить точечно — `sortable: false`).
 * Так сортировка появляется во ВСЕХ списках на `AdminTable` без правки
 * мест вызова. Тип значения (дата/число/строка) определяется по тексту
 * ячейки — см. `admin-table-view.client.tsx`.
 */
import type { Key, ReactNode } from 'react';

import {
  AdminTableView,
  type AdminTableBodyRow,
  type AdminTableColumnMeta,
} from './admin-table-view.client';

export interface AdminTableColumn<T> {
  key: string;
  /** Заголовок колонки. */
  header: ReactNode;
  /** Что отрендерить в ячейке. */
  render: (row: T) => ReactNode;
  /** Выравнивание содержимого. */
  align?: 'left' | 'right' | 'center';
  /** Ячейка действий — без `data-label` на мобильном и без сортировки. */
  isAction?: boolean;
  /** Подпись колонки в тексте `data-label` (по умолчанию `header`). */
  mobileLabel?: string;
  /**
   * Разрешить сортировку по колонке. По умолчанию сортируемы все колонки,
   * кроме `isAction`. Передайте `false`, чтобы отключить (например, для
   * чисто визуальной колонки), или `true`, чтобы включить у `isAction`.
   */
  sortable?: boolean;
}

interface AdminTableProps<T> {
  rows: T[];
  columns: AdminTableColumn<T>[];
  rowKey: (row: T) => Key;
  /** Что показать, если строк нет. По умолчанию ничего — пусть страница
   *  сама подставит `<AdminEmptyState>`. */
  emptyContent?: ReactNode;
  className?: string;
  /**
   * Если задан и возвращает href — вся строка становится кликабельной и ведёт
   * на этот href (как кнопка «Открыть» в строке). Клики по вложенным ссылкам,
   * кнопкам и полям продолжают работать сами по себе. Верните `null`/`undefined`,
   * чтобы строка осталась некликабельной (например, у итоговой строки).
   */
  rowHref?: (row: T) => string | null | undefined;
}

export function AdminTable<T>({
  rows,
  columns,
  rowKey,
  emptyContent,
  className,
  rowHref,
}: AdminTableProps<T>) {
  if (rows.length === 0 && emptyContent != null) {
    return <>{emptyContent}</>;
  }

  const columnsMeta: AdminTableColumnMeta[] = columns.map((c) => ({
    key: c.key,
    header: c.header,
    align: c.align,
    isAction: c.isAction ?? false,
    sortable: c.sortable ?? !c.isAction,
  }));

  const bodyRows: AdminTableBodyRow[] = rows.map((row) => {
    const cells = columns.map((c) => {
      const label =
        typeof c.mobileLabel === 'string'
          ? c.mobileLabel
          : typeof c.header === 'string'
            ? c.header
            : undefined;
      return (
        <td
          key={c.key}
          data-label={c.isAction ? undefined : label}
          className={c.isAction ? 'admin-table__actions' : undefined}
          style={c.align ? { textAlign: c.align } : undefined}
        >
          {c.render(row)}
        </td>
      );
    });
    return {
      key: String(rowKey(row)),
      href: rowHref?.(row) ?? null,
      cells,
    };
  });

  return (
    <AdminTableView
      columns={columnsMeta}
      rows={bodyRows}
      className={className}
    />
  );
}
