import Link from 'next/link';
import { BadgeRussianRuble } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listEmployees } from '@/lib/employees-api';
import { CreateAccrualDocumentForm } from './create-form';

export const dynamic = 'force-dynamic';

/**
 * Страница создания документа начисления зарплаты (PHASE 3 STEP 6.3).
 *
 * Менеджер указывает `accrualDate` — дату расчёта включительно — и
 * опционально конкретного сотрудника (иначе документ формируется по
 * всем сотрудникам). Система включает в документ все неоплаченные
 * утверждённые начисления и окладные дни до этой даты.
 */
export default async function AdminNewAccrualDocumentPage() {
  const employees = await listEmployees({ active: true }).catch(() => []);

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Начислить зарплату"
      subtitle="Сформировать документ начисления зарплаты на дату"
      actions={
        <Link
          href="/admin/payroll/accrual-documents"
          className="admin-btn admin-btn--ghost"
        >
          ← К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры начисления" />
        <p
          className="admin-muted"
          style={{ marginBottom: '1rem', fontSize: '0.9rem' }}
        >
          Документ включит только неоплаченные утверждённые начисления и
          окладные дни до выбранной даты включительно. Можно ограничить
          документ одним сотрудником.
        </p>
        <CreateAccrualDocumentForm employees={employees} />
      </AdminCard>
    </AdminPageShell>
  );
}
