import Link from 'next/link';
import { ArrowLeft, Factory } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateEquipmentForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание оборудования (Admin UI 2.5, ADR-0017).
 *
 * Backend / DTO не меняем. Список операций — из `GET /api/shifts/meta`.
 */
export default async function AdminEquipmentNewPage() {
  let operations: readonly OperationLiteDto[] = [];
  let metaError: string | null = null;
  try {
    const meta = await getShiftMeta();
    operations = meta.operations;
  } catch (e) {
    metaError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список операций — настройте позже на карточке.';
    operations = [];
  }

  return (
    <AdminPageShell
      icon={<Factory size={22} strokeWidth={1.6} aria-hidden />}
      title="Новое оборудование"
      subtitle="Минимум — название. Операции можно добавить позже."
      actions={
        <Link href="/admin/equipment" className="admin-btn admin-btn--ghost">
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
        <CreateEquipmentForm operations={operations} />
      </AdminCard>
    </AdminPageShell>
  );
}
