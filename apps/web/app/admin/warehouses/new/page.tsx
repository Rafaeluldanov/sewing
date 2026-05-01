import Link from 'next/link';
import { ArrowLeft, Warehouse } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateWarehouseForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание склада (Admin UI 2.5).
 *
 * Backend / DTO не меняем. После успеха server action редиректит на
 * `/admin/warehouses/[id]` — менеджер сразу собирает линии и ячейки.
 */
export default function AdminWarehouseNewPage() {
  return (
    <AdminPageShell
      icon={<Warehouse size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый склад"
      subtitle="Минимум — название. Линии и ячейки настраиваются дальше."
      actions={
        <Link href="/admin/warehouses" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreateWarehouseForm />
      </AdminCard>
    </AdminPageShell>
  );
}
