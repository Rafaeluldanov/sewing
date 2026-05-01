import { ApiRequestError } from '@/lib/api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { RouteTemplateForm } from '../route-template-form';

export const dynamic = 'force-dynamic';

/**
 * Страница создания нового шаблона маршрута. Список доступных операций
 * берём из `GET /api/shifts/meta` — там уже отдаются только активные,
 * отсортированные по `sortOrder`. Тот же подход использует
 * `/admin/equipment/new`.
 */
export default async function AdminRoutesNewPage() {
  let operations: readonly OperationLiteDto[] = [];
  let metaError: string | null = null;
  try {
    const meta = await getShiftMeta();
    operations = meta.operations;
  } catch (e) {
    metaError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список операций — можно собрать шаблон позже.';
    operations = [];
  }

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Маршруты производства"
        icon="operations"
        title="Новый шаблон маршрута"
        subtitle="Минимум — код и название. Шаги можно добавить здесь же или позже на карточке шаблона. Snapshot маршрута фиксируется на заказе при запуске."
        backHref="/admin/routes"
        backLabel="К списку шаблонов"
      />

      {metaError && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{metaError}</div>
        </div>
      )}

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Параметры шаблона
          </h2>
        </div>
        <RouteTemplateForm mode="create" operations={operations} />
      </section>
    </div>
  );
}
