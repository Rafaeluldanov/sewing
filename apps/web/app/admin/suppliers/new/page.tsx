import Link from 'next/link';
import { ArrowLeft, Truck } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateSupplierForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание поставщика (`/admin/suppliers/new`, Этап 5).
 *
 * После успеха server action редиректит на `/admin/suppliers/[id]`,
 * где менеджер сразу может добавить контакты и каталог.
 */
export default function AdminSupplierNewPage() {
  return (
    <AdminPageShell
      icon={<Truck size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый поставщик"
      subtitle="Минимум: название. Контакты и каталог — на следующем шаге."
      actions={
        <Link href="/admin/suppliers" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreateSupplierForm />
      </AdminCard>
    </AdminPageShell>
  );
}
