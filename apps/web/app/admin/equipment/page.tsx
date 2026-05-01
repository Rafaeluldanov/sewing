import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listEquipment } from '@/lib/equipment-api';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

/**
 * Список оборудования с числом включённых операций (см. ADR-0017,
 * `docs/screens.md §10a`). Источник истины — `GET /api/equipment`.
 *
 * Создание нового станка вынесено на отдельную страницу
 * `/admin/equipment/new` — раньше форма жила прямо в списке и
 * визуально его перегружала. На списке остаётся только заметная
 * кнопка «Добавить оборудование» в actions шапки.
 *
 * Доступ ограничен слой выше — `app/admin/layout.tsx` редиректит всех,
 * кроме `ADMIN` и `SHOP_MANAGER`. Backend дополнительно защищает
 * `/api/equipment/*` через `@Roles('SHOP_MANAGER', 'ADMIN')`.
 */
export default async function AdminEquipmentListPage() {
  let items: EquipmentSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listEquipment();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список оборудования';
  }

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="equipment" />
            Производственный парк
          </div>
          <h1 className="page-title">
            <Icon name="equipment" />
            Оборудование
          </h1>
          <p className="page-subtitle">
            Управление списком оборудования и разрешённых операций по каждому
            станку. Создание нового станка или рабочего места — на отдельной
            странице.
          </p>
        </div>
        <div className="admin-overview__actions">
          <Link href="/admin/equipment/new" className="btn btn-primary">
            <Icon name="plus" size={16} />
            Добавить оборудование
          </Link>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {items.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="equipment" />
          </span>
          <span className="empty-state__title">Оборудование ещё не заведено</span>
          <span className="empty-state__hint">
            <Link href="/admin/equipment/new">Добавьте первый станок</Link> —
            это займёт меньше минуты.
          </span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th title="Ручной номер для физической маркировки станка">№</th>
              <th>Код</th>
              <th>Название</th>
              <th>Активно</th>
              <th>Операций</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((eq) => (
              <tr key={eq.id}>
                <td>
                  {eq.displayNumber ? (
                    <strong
                      style={{ fontSize: '1.15rem' }}
                      title="Ручной номер станка"
                    >
                      №{eq.displayNumber}
                    </strong>
                  ) : (
                    <span
                      className="meta-line"
                      title="Номер не задан — задайте в карточке оборудования"
                    >
                      —
                    </span>
                  )}
                </td>
                <td>
                  <code>{eq.code}</code>
                </td>
                <td>{eq.name}</td>
                <td>
                  {eq.active ? 'да' : <span className="meta-line">нет</span>}
                </td>
                <td>
                  {eq.allowedOperationsCount === 0 ? (
                    <span className="meta-line" title="Швея не сможет открыть смену на этом станке">
                      0 — не настроено
                    </span>
                  ) : (
                    eq.allowedOperationsCount
                  )}
                </td>
                <td>
                  <Link href={`/admin/equipment/${eq.id}`}>
                    Настроить <Icon name="arrow-right" size={13} />
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
