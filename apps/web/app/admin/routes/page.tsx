import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listRouteTemplates } from '@/lib/routes-api';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

/**
 * Список шаблонов маршрутов производства (см. `docs/screens.md §«Маршруты»`,
 * `docs/domain.md §«Маршруты производства»`). Источник истины —
 * `GET /api/routes`.
 *
 * Доступ ограничен слой выше (`app/admin/layout.tsx` пускает только
 * ADMIN/SHOP_MANAGER); backend независимо защищает запись через
 * `@Roles('ADMIN', 'SHOP_MANAGER')` в `RoutesController`.
 *
 * Создание нового шаблона вынесено на отдельную страницу `/new`,
 * чтобы не перегружать список редактором — тот же паттерн, что
 * у `/admin/equipment`.
 */
export default async function AdminRoutesListPage() {
  let items: RouteTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listRouteTemplates();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список шаблонов маршрутов';
  }

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="operations" />
            Производственный план
          </div>
          <h1 className="page-title">
            <Icon name="operations" />
            Маршруты производства
          </h1>
          <p className="page-subtitle">
            Шаблоны последовательности операций. При создании заказа можно
            привязать шаблон — при запуске заказа маршрут зафиксируется
            snapshot-ом, и UI на /work будет подсказывать швее текущий и
            следующий шаг. Это «мягкий» маршрут: scan «не туда» не
            блокируется, только показывается предупреждение.
          </p>
        </div>
        <div className="admin-overview__actions">
          <Link href="/admin/routes/new" className="btn btn-primary">
            <Icon name="plus" size={16} />
            Новый шаблон
          </Link>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {items.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="operations" />
          </span>
          <span className="empty-state__title">
            Шаблоны маршрутов ещё не заведены
          </span>
          <span className="empty-state__hint">
            <Link href="/admin/routes/new">Создайте первый шаблон</Link> —
            например, «Базовая футболка» с операциями раскрой → пошив → ОТК →
            ВТО → упаковка.
          </span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Код</th>
              <th>Название</th>
              <th>Активен</th>
              <th>Шагов</th>
              <th>Обновлён</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((tpl) => (
              <tr key={tpl.id}>
                <td>
                  <code>{tpl.code}</code>
                </td>
                <td>{tpl.name}</td>
                <td>
                  {tpl.isActive ? (
                    'да'
                  ) : (
                    <span className="meta-line">нет</span>
                  )}
                </td>
                <td>
                  {tpl.stepsCount === 0 ? (
                    <span
                      className="meta-line"
                      title="Шаблон без шагов: snapshot не создастся"
                    >
                      0 — пусто
                    </span>
                  ) : (
                    tpl.stepsCount
                  )}
                </td>
                <td>
                  <span className="meta-line">
                    {new Date(tpl.updatedAt).toLocaleString('ru-RU')}
                  </span>
                </td>
                <td>
                  <Link href={`/admin/routes/${tpl.id}`}>
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
