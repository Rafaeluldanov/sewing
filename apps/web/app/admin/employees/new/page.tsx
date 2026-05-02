import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { CreateEmployeeForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание сотрудника (Admin UI 2.5).
 *
 * PHASE 2 STEP 2: подгружаем список активных подразделений
 * (`CompanyDivision`) для select-а «Подразделение». Если backend
 * недоступен или у проекта нет ни одного активного подразделения —
 * select прячется (форма работает как раньше, без привязки).
 */
export default async function AdminEmployeeNewPage() {
  const divisions = await listCompanyDivisions({ includeInactive: false }).catch(
    () => [],
  );
  const divisionOptions = divisions.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
  }));

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
        <CreateEmployeeForm divisionOptions={divisionOptions} />
      </AdminCard>
    </AdminPageShell>
  );
}
