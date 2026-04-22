import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { TechCardForm } from '../tech-card-form';

export const dynamic = 'force-dynamic';

/**
 * Создание новой техкарты. Минимум — код и название; материалы /
 * внешние потребности можно добавить здесь же или позже на карточке
 * (см. `docs/screens.md §«Техкарты»`).
 */
export default function AdminTechCardsNewPage() {
  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Техкарты"
        icon="orders"
        title="Новая техкарта"
        subtitle="Заполните код и название. Строки материалов и внешних потребностей опциональны — добавьте те, что фиксируются в плане. Snapshot техкарты создаётся на заказе при запуске."
        backHref="/admin/tech-cards"
        backLabel="К списку техкарт"
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Параметры техкарты
          </h2>
        </div>
        <TechCardForm mode="create" />
      </section>
    </div>
  );
}
