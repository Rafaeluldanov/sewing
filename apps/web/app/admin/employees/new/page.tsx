import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { listAppRolesSafe } from '@/lib/app-roles-api';
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
  // Роли берём из справочника (`/admin/roles`): их заводят из админки,
  // зашитого перечня в форме больше нет. `DISPLAY`/`SUPERADMIN`
  // исключаем — учётку монитора создаёт «Цеховой монитор», а
  // супер-админ живёт в control-plane.
  const [divisions, appRoles] = await Promise.all([
    listCompanyDivisions({ includeInactive: false }).catch(() => []),
    listAppRolesSafe(),
  ]);
  const divisionOptions = divisions.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
  }));
  const roleOptions = appRoles
    .filter((r) => r.active && r.code !== 'DISPLAY' && r.code !== 'SUPERADMIN')
    .map((r) => ({ code: r.code, name: r.name }));

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
        <CreateEmployeeForm
          divisionOptions={divisionOptions}
          roleOptions={roleOptions}
        />
      </AdminCard>
    </AdminPageShell>
  );
}
