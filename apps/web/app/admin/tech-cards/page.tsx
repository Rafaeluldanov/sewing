import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listTechCards } from '@/lib/tech-cards-api';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

/**
 * Список шаблонов техкарт (см. `docs/screens.md §«Техкарты»`,
 * `docs/domain.md §«Техкарты»`, ADR-0022). Источник истины —
 * `GET /api/tech-cards`.
 *
 * Доступ ограничен слоем выше (`app/admin/layout.tsx` пускает только
 * ADMIN/SHOP_MANAGER); backend независимо защищает запись через
 * `@Roles('ADMIN', 'SHOP_MANAGER')` в `TechCardsController`.
 */
export default async function AdminTechCardsListPage() {
  let items: TechCardTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listTechCards();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список техкарт';
  }

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="orders" />
            Производственный план
          </div>
          <h1 className="page-title">
            <Icon name="orders" />
            Техкарты
          </h1>
          <p className="page-subtitle">
            Шаблоны потребностей на единицу изделия: материалы и внешние
            подрядные размещения. При создании заказа можно опционально
            привязать техкарту — при запуске заказа план потребностей
            фиксируется snapshot-ом и больше не меняется при правках
            шаблона. Маршрут производства и техкарта — независимые сущности.
          </p>
        </div>
        <div className="admin-overview__actions">
          <Link href="/admin/tech-cards/new" className="btn btn-primary">
            <Icon name="plus" size={16} />
            Новая техкарта
          </Link>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {items.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="orders" />
          </span>
          <span className="empty-state__title">
            Техкарты ещё не заведены
          </span>
          <span className="empty-state__hint">
            <Link href="/admin/tech-cards/new">Создайте первую</Link> —
            например, «Базовая футболка»: ткань, нитки, лейблы, шелкография
            (внешний подряд).
          </span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Код</th>
              <th>Название</th>
              <th>Активна</th>
              <th className="num">Материалов</th>
              <th className="num">Внешних</th>
              <th>Обновлена</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((tc) => (
              <tr key={tc.id}>
                <td>
                  <code>{tc.code}</code>
                </td>
                <td>{tc.name}</td>
                <td>
                  {tc.isActive ? (
                    'да'
                  ) : (
                    <span className="meta-line">нет</span>
                  )}
                </td>
                <td className="num">{tc.materialLinesCount}</td>
                <td className="num">{tc.outsourceLinesCount}</td>
                <td>
                  <span className="meta-line">
                    {new Date(tc.updatedAt).toLocaleString('ru-RU')}
                  </span>
                </td>
                <td>
                  <Link href={`/admin/tech-cards/${tc.id}`}>
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
