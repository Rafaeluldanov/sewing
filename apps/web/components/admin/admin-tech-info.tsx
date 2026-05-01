/**
 * AdminTechInfo — collapsible-блок «Техническая информация» для
 * detail-pages.
 *
 * Сюда складываем поля, которые раньше шумели в списках: ID, code,
 * QR-токены, updatedAt и пр. На карточке пользователь видит только
 * человеческие данные; кому надо — раскроет «Техническая информация»
 * и увидит исходные значения.
 *
 * Реализовано через `<details>`, чтобы:
 *   - не таскать клиентский state и не делать компонент `'use client'`;
 *   - на мобильном работало через нативный disclosure без жестов.
 */
import type { ReactNode } from 'react';

interface TechInfoItem {
  label: string;
  value: ReactNode;
}

interface AdminTechInfoProps {
  items: TechInfoItem[];
  /** По умолчанию — «Техническая информация». */
  title?: string;
}

export function AdminTechInfo({
  items,
  title = 'Техническая информация',
}: AdminTechInfoProps) {
  if (items.length === 0) return null;
  return (
    <details className="admin-tech-info">
      <summary>{title}</summary>
      <dl>
        {items.map((it) => (
          <div key={it.label} style={{ display: 'contents' }}>
            <dt>{it.label}</dt>
            <dd>{it.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
