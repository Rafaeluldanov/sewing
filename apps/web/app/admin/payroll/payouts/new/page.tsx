import Link from 'next/link';
import { ArrowLeft, BadgeRussianRuble } from 'lucide-react';
import { AdminCard, AdminPageShell, AdminSectionHeader } from '@/components/admin';
import { listEmployees } from '@/lib/employees-api';
import { CreatePayrollPayoutForm } from './create-form';

export const dynamic = 'force-dynamic';

/**
 * Форма создания новой выплаты (PHASE 3 STEP 4).
 *
 * RSC-страница загружает список активных сотрудников и передаёт
 * в клиентский компонент `CreatePayrollPayoutForm`, который
 * обрабатывает валидацию и вызывает `createPayrollPayoutAction`.
 *
 * После успешного создания action редиректит на
 * `/admin/payroll/payouts/:id`.
 */
export default async function AdminPayrollPayoutsNewPage() {
  const employees = await listEmployees({ active: true }).catch(() => []);

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Создать выплату"
      subtitle="Новая выплата зарплаты сотруднику"
      actions={
        <Link
          href="/admin/payroll/payouts"
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры выплаты" />
        <CreatePayrollPayoutForm employees={employees} />
      </AdminCard>
    </AdminPageShell>
  );
}
