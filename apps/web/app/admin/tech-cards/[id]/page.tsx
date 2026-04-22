import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getTechCard } from '@/lib/tech-cards-api';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { TechCardForm } from '../tech-card-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка техкарты. Источник истины — `GET /api/tech-cards/:id`.
 *
 * Все поля (`code`, `name`, `isActive`, `materialLines[]`,
 * `outsourceLines[]`) редактируются в одной форме и сохраняются одним
 * PATCH-ом — backend `TechCardsService.update` обновляет частично, а
 * массивы строк заменяет целиком (full-replace) в одной транзакции,
 * по аналогии с `RoutesService.replaceSteps` и
 * `EquipmentOperationsService`.
 *
 * Удаление шаблона на MVP не выставляется (UI и backend): техкарта
 * может быть зашита в snapshot заказов, и soft-deactivation
 * (isActive=false) закрывает все use-кейсы. Snapshot заказа
 * (`OrderMaterialRequirement[]` / `OrderOutsourceRequirement[]`) живёт
 * независимо от шаблона: FK на `TechCard*Line.sourceTechCardLineId`
 * имеет `ON DELETE SET NULL` — даже после удаления строк snapshot
 * заказа продолжает работать (см. `prisma/schema.prisma`, ADR-0022).
 */
export default async function AdminTechCardDetailPage({ params }: Params) {
  let template;
  try {
    template = await getTechCard(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Техкарты"
        icon="orders"
        title={template.name}
        subtitle="Редактирование техкарты. Изменения вступают в силу для будущих заказов; уже запущенные заказы продолжают работать со своим snapshot-ом потребностей."
        backHref="/admin/tech-cards"
        backLabel="К списку техкарт"
        meta={
          <>
            <span>
              Код: <code>{template.code}</code>
            </span>
            <span>·</span>
            <span>Материалов: {template.materialLines.length}</span>
            <span>·</span>
            <span>Внешних: {template.outsourceLines.length}</span>
            <span>·</span>
            <span>
              Обновлена:{' '}
              {new Date(template.updatedAt).toLocaleString('ru-RU')}
            </span>
          </>
        }
        badges={
          <span
            className={`pill ${template.isActive ? 'pill--ok' : 'pill--ghost'}`}
          >
            <Icon name={template.isActive ? 'success' : 'idle'} size={14} />
            {template.isActive ? 'Активна' : 'Скрыта'}
          </span>
        }
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="orders" />
            Параметры и строки техкарты
          </h2>
          <span className="section-header__hint">
            Snapshot фиксируется на заказе при запуске
          </span>
        </div>
        <TechCardForm mode="edit" template={template} />
      </section>
    </div>
  );
}
