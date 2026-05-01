import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listWarehouses } from '@/lib/warehouses-api';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

/**
 * Список складов (см. `docs/screens.md §10b`).
 *
 * Источник истины — `GET /api/warehouses` (роли `ADMIN`/`SHOP_MANAGER`).
 * Доступ к разделу режется выше — `app/admin/layout.tsx` редиректит
 * всех, кроме `ADMIN`/`SHOP_MANAGER`. Backend дополнительно
 * защищает `/api/warehouses/*` через `@Roles('SHOP_MANAGER', 'ADMIN')`.
 *
 * Создание нового склада вынесено на отдельную страницу
 * `/admin/warehouses/new` — раньше форма жила прямо в списке и
 * визуально его перегружала. На списке остаётся только заметная
 * primary-кнопка «Добавить склад» в actions шапки. Тот же UX уже
 * применён к `/admin/equipment` (ADR-0017) и `/admin/operations`
 * (ADR-0020).
 */
export default async function AdminWarehousesListPage() {
  let items: WarehouseSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listWarehouses();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список складов';
  }

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="warehouses" />
            Хранение
          </div>
          <h1 className="page-title">
            <Icon name="warehouses" />
            Склады
          </h1>
          <p className="page-subtitle">
            Управленческая группировка ячеек физического хранения. Привязка
            ячейки к складу и печать QR — на карточке склада. Создание
            нового склада — на отдельной странице.
          </p>
        </div>
        <div className="admin-overview__actions">
          <Link href="/admin/warehouses/new" className="btn btn-primary">
            <Icon name="plus" size={16} />
            Добавить склад
          </Link>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {items.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="warehouses" />
          </span>
          <span className="empty-state__title">Складов пока нет</span>
          <span className="empty-state__hint">
            <Link href="/admin/warehouses/new">Создайте первый склад</Link> —
            это займёт меньше минуты.
          </span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Код</th>
              <th>Активен</th>
              <th>Ячеек</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id}>
                <td>
                  <strong>{w.name}</strong>
                </td>
                <td>
                  {w.code ? <code>{w.code}</code> : (
                    <span className="meta-line">—</span>
                  )}
                </td>
                <td>
                  {w.isActive ? 'да' : <span className="meta-line">нет</span>}
                </td>
                <td>
                  {w.cellsCount === 0 ? (
                    <span
                      className="meta-line"
                      title="К складу ещё не привязано ни одной ячейки"
                    >
                      0
                    </span>
                  ) : (
                    w.cellsCount
                  )}
                </td>
                <td>
                  <Link href={`/admin/warehouses/${w.id}`}>
                    Открыть <Icon name="arrow-right" size={13} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
