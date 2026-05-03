import Link from 'next/link';
import { BadgeRussianRuble } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateAccrualDocumentForm } from './create-form';

/**
 * Страница создания документа начисления зарплаты (PHASE 3 STEP 6.3).
 *
 * Менеджер указывает `accrualDate` — дату расчёта включительно.
 * Система включает в документ все неоплаченные утверждённые начисления
 * и окладные дни до этой даты.
 */
export default function AdminNewAccrualDocumentPage() {
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
          окладные дни до выбранной даты включительно.
        </p>
        <CreateAccrualDocumentForm />
      </AdminCard>
    </AdminPageShell>
  );
}
