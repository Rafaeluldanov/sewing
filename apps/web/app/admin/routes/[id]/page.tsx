import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, ArrowLeft, Trash2 } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getRouteTemplate } from '@/lib/routes-api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminRouteSteps,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
  type AdminRouteStep,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import { RouteTemplateForm } from '../route-template-form';
import { deleteRouteTemplateAction } from '../actions';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка шаблона маршрута (Admin UI 2.6).
 *
 * Backend / DTO не меняем — `RouteTemplateForm` принимает прежний
 * input. Над формой редактирования теперь отдельная карточка
 * «Операции маршрута» с компактной цепочкой шагов
 * (`AdminRouteSteps`) — менеджер сразу видит готовый pipeline без
 * необходимости разворачивать форму.
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
        : 'Не удалось загрузить список операций.';
    operations = template.steps.map((s) => ({
      id: s.operationId,
      code: s.operationCode,
      name: s.operationName,
      category: '—',
      sortOrder: s.index,
      active: true,
    }));
  }

  const opCategoryById = new Map<string, string>();
  for (const op of operations) opCategoryById.set(op.id, op.category);

  const routeSteps: AdminRouteStep[] = template.steps
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((s, i) => ({
      id: s.id,
      index: i + 1,
      name: s.operationName,
      category: opCategoryById.get(s.operationId) ?? null,
      parallelGroup: s.parallelGroup,
    }));

  return (
    <AdminPageShell
      icon={<Activity size={22} strokeWidth={1.6} aria-hidden />}
      title={template.name}
      subtitle={`${template.steps.length} шагов`}
      actions={
        <>
          <Link href="/admin/routes" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(template.isActive)}>
            {formatStatus(template.isActive)}
          </AdminStatusBadge>
        </>
      }
    >
      {metaError && (
        <div className="error-box" role="alert">
          {metaError}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Операции маршрута" />
        {routeSteps.length === 0 ? (
          <AdminEmptyState
            icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
            title="Шагов пока нет"
            hint="Добавьте операции в форме ниже."
          />
        ) : (
          <AdminRouteSteps steps={routeSteps} />
        )}
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Редактирование" />
        <RouteTemplateForm
          mode="edit"
          template={template}
          operations={operations}
        />
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Опасная зона" />
        <form action={deleteRouteTemplateAction} className="admin-actions-row">
          <input type="hidden" name="id" value={template.id} />
          <button type="submit" className="admin-btn admin-btn--danger">
            <Trash2 size={16} strokeWidth={1.6} aria-hidden />
            Удалить шаблон
          </button>
        </form>
      </AdminCard>

      <AdminTechInfo
        items={[
          { label: 'ID', value: <code>{template.id}</code> },
          { label: 'Код', value: <code>{template.code}</code> },
          { label: 'Шагов', value: template.steps.length },
          {
            label: 'Обновлён',
            value: new Date(template.updatedAt).toLocaleString('ru-RU'),
          },
        ]}
      />
    </AdminPageShell>
  );
}
