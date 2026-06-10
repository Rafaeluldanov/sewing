import Link from 'next/link';
import { Activity, ArrowLeft } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { RouteTemplateForm } from '../route-template-form';

export const dynamic = 'force-dynamic';

/**
 * Создание шаблона маршрута (Admin UI 2.5).
 *
 * Backend / DTO не меняем. Список операций — из `GET /api/shifts/meta`.
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
        ? errorText(e)
        : 'Не удалось загрузить список операций — добавьте шаги позже.';
    operations = [];
  }

  return (
    <AdminPageShell
      icon={<Activity size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый шаблон маршрута"
      subtitle="Код, название и последовательность шагов"
      actions={
        <Link href="/admin/routes" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      {metaError && (
        <div className="error-box" role="alert">
          {metaError}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <RouteTemplateForm mode="create" operations={operations} />
      </AdminCard>
    </AdminPageShell>
  );
}
