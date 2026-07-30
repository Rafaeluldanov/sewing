import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ShieldCheck, Users } from 'lucide-react';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { getAppRole, listAppRolesSafe } from '@/lib/app-roles-api';
import { RoleForm } from '../role-form';

export const dynamic = 'force-dynamic';

/**
 * Карточка роли (`/admin/roles/[id]`).
 *
 * У системной роли форма показывает только название под замком —
 * структура (наследование, рабочий экран) зашита в коде приложения.
 */
export default async function AdminRoleCardPage({
  params,
}: {
  params: { id: string };
}) {
  let role: AppRoleDto;
  try {
    role = await getAppRole(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const all = await listAppRolesSafe();
  // Себя в доноры не предлагаем (роль не наследует саму себя), архивные
  // — тоже. Уже отмеченные архивные коды при этом сохранятся: форма
  // отправляет их скрытыми input-ами по состоянию `role.inherits`… но
  // чипа для них не будет, поэтому снять такую связь можно только
  // восстановив роль из архива. Это осознанный компромисс: молча
  // терять наследование при сохранении — хуже.
  const candidates = all.filter((r) => r.active && r.code !== role.code);

  return (
    <AdminPageShell
      icon={<ShieldCheck size={22} strokeWidth={1.6} aria-hidden />}
      title={role.name}
      subtitle={
        role.system
          ? `Системная роль · ${role.code}`
          : `Своя роль · ${role.code}`
      }
      actions={
        <Link href="/admin/roles" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Параметры"
          hint={
            role.employeeCount > 0
              ? `Роль назначена сотрудникам: ${role.employeeCount}. Правка прав применится к ним сразу.`
              : 'Роль пока никому не назначена.'
          }
          actions={
            role.employeeCount > 0 ? (
              <Link
                href="/admin/company-settings?tab=access"
                className="admin-btn admin-btn--ghost"
              >
                <Users size={15} strokeWidth={1.6} aria-hidden />
                Кому выдана
              </Link>
            ) : undefined
          }
        />
        <RoleForm role={role} candidates={candidates} />
      </AdminCard>
    </AdminPageShell>
  );
}
