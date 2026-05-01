import Link from 'next/link';
import { ArrowLeft, Building2 } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateClientForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание клиента (`/admin/clients/new`).
 *
 * Backend / DTO простой: имя обязательно, остальное опционально.
 * После успеха server action редиректит на `/admin/clients/[id]`,
 * чтобы менеджер сразу мог проверить и при необходимости подправить.
 */
export default function AdminClientNewPage() {
  return (
    <AdminPageShell
      icon={<Building2 size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый клиент"
      subtitle="Минимум: название. Остальное — по желанию."
      actions={
        <Link href="/admin/clients" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreateClientForm />
      </AdminCard>
    </AdminPageShell>
  );
}
