import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateEmployeeForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание сотрудника (Admin UI 2.5).
 *
 * Backend / DTO не меняем. После успешного create server action
 * редиректит на `/admin/employees/[id]` — менеджер сразу проверяет
 * и допиливает компенсацию.
 */
export default function AdminEmployeeNewPage() {
  return (
    <AdminPageShell
      icon={<Users size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый сотрудник"
      subtitle="Минимум: ФИО, логин, PIN, роль, тип оплаты"
      actions={
        <Link href="/admin/employees" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreateEmployeeForm />
      </AdminCard>
    </AdminPageShell>
  );
}
