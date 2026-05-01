/**
 * `CategorySection` — карточка-обёртка для группы операций/оборудования
 * по категории (см. ТЗ «Единая группировка операций и оборудования»).
 *
 * UI задаётся одинаково на всех экранах:
 *   - заголовок «Раскрой» / «Пошив» / «ОТК» / «ВТО» / «Упаковка» /
 *     «Без категории» / «Без операций» — берётся из shared-helper'а
 *     `OPERATION_CATEGORY_LABELS` (источник истины);
 *   - справа — счётчик элементов в группе;
 *   - содержимое — произвольный children (таблица / список / карточки).
 *
 * Если в группе ноль элементов — компонент не должен вызываться
 * (см. `groupOperationsByCategory` / `groupEquipmentByOperationCategory`,
 * которые такие группы отбрасывают).
 */
import type { ReactNode } from 'react';
import { AdminCard } from './admin-card';

interface CategorySectionProps {
  /**
   * Технический ключ категории (`CUTTING` / `SEWING` / … / `UNKNOWN`).
   * Прокидывается в `data-category`, чтобы smoke-тесты и e2e могли
   * убедиться, что секция существует и подписана правильным enum'ом
   * без сравнения локализованных строк.
   */
  categoryKey: string;
  /** Локализованный заголовок группы. */
  title: ReactNode;
  /** Сколько элементов в группе (рисуется как мягкий счётчик справа). */
  count: number;
  children: ReactNode;
}

export function CategorySection({
  categoryKey,
  title,
  count,
  children,
}: CategorySectionProps) {
  return (
    <AdminCard>
      <header
        className="admin-category-section__header"
        data-category={categoryKey}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 'var(--admin-space-sm, 0.5rem)',
        }}
      >
        <h2
          className="admin-section-title"
          style={{ margin: 0 }}
          data-category-title={categoryKey}
        >
          {title}
        </h2>
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {count}
        </span>
      </header>
      {children}
    </AdminCard>
  );
}
