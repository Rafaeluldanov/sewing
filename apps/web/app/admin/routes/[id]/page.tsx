import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getRouteTemplate } from '@/lib/routes-api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { RouteTemplateForm } from '../route-template-form';
import { deleteRouteTemplateAction } from '../actions';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка шаблона маршрута. Источник истины — `GET /api/routes/:id`.
 *
 * Все поля (`code`, `name`, `isActive`, `steps`) редактируются в одной
 * форме и сохраняются одним PATCH-ом — backend `RoutesService.update`
 * умеет частичный апдейт, но в UI на MVP отдельные секции дробить
 * необязательно: набор полей маленький, а замена steps всё равно идёт
 * целиком (см. `RoutesService.replaceSteps`).
 *
 * Удаление вынесено в отдельную форму ниже — снапшоты маршрутов на
 * запущенных заказах не зависят от шаблона и переживут удаление
 * (см. `OrderRouteStep`).
 */
export default async function AdminRouteTemplateDetailPage({ params }: Params) {
  let template;
  try {
    template = await getRouteTemplate(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  let operations: readonly OperationLiteDto[] = [];
  let metaError: string | null = null;
  try {
    const meta = await getShiftMeta();
    operations = meta.operations;
  } catch (e) {
    metaError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список операций — отредактировать шаги нельзя, но код/название/активность доступны.';
    operations = template.steps.map((s) => ({
      id: s.operationId,
      code: s.operationCode,
      name: s.operationName,
      category: '—',
      sortOrder: s.index,
      active: true,
    }));
  }

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Маршруты производства"
        icon="operations"
        title={template.name}
        subtitle="Редактирование шаблона маршрута. Изменения вступают в силу для будущих заказов; уже запущенные заказы продолжают идти по своему snapshot-у."
        backHref="/admin/routes"
        backLabel="К списку шаблонов"
        meta={
          <>
            <span>
              Код: <code>{template.code}</code>
            </span>
            <span>·</span>
            <span>Шагов: {template.steps.length}</span>
            <span>·</span>
            <span>
              Обновлён:{' '}
              {new Date(template.updatedAt).toLocaleString('ru-RU')}
            </span>
          </>
        }
        badges={
          <span
            className={`pill ${template.isActive ? 'pill--ok' : 'pill--ghost'}`}
          >
            <Icon name={template.isActive ? 'success' : 'idle'} size={14} />
            {template.isActive ? 'Активен' : 'Скрыт'}
          </span>
        }
      />

      {metaError && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{metaError}</div>
        </div>
      )}

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="operations" />
            Параметры и шаги маршрута
          </h2>
          <span className="section-header__hint">
            Snapshot фиксируется на заказе при запуске
          </span>
        </div>
        <RouteTemplateForm
          mode="edit"
          template={template}
          operations={operations}
        />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="warning" />
            Опасная зона
          </h2>
        </div>
        <p className="detail-form__hint">
          Удаление шаблона убирает его из списка выбора в новых заказах. Уже
          запущенные заказы продолжат идти по своему snapshot-у —
          <code>OrderRouteStep[]</code> хранится отдельно от шаблона. Если
          шаблон просто не нужен больше — лучше снять галочку «Активен»
          в форме выше: его не будет видно при создании новых заказов, но
          история сохранится.
        </p>
        <form action={deleteRouteTemplateAction} className="detail-form__actions">
          <input type="hidden" name="id" value={template.id} />
          <button type="submit" className="btn btn-danger">
            <Icon name="error" size={16} />
            Удалить шаблон
          </button>
        </form>
      </section>
    </div>
  );
}
