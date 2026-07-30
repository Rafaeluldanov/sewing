import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listAppRolesSafe } from '@/lib/app-roles-api';
import { RoleForm } from '../role-form';

export const dynamic = 'force-dynamic';

/**
 * Создание роли (`/admin/roles/new`).
 *
 * Кандидаты в доноры прав — только АКТИВНЫЕ роли: наследоваться от
 * роли, выведенной в архив, значит закладывать мину на будущее.
 */
export default async function AdminRoleNewPage() {
  const all: AppRoleDto[] = await listAppRolesSafe();
  const candidates = all.filter((r) => r.active);

  return (
    <AdminPageShell
      icon={<ShieldCheck size={22} strokeWidth={1.6} aria-hidden />}
      title="Новая роль"
      subtitle="Название + от каких ролей наследует права"
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
          hint="Права роль получает наследованием — отметьте роли, чьи разрешения она забирает целиком."
        />
        <RoleForm candidates={candidates} />
      </AdminCard>
    </AdminPageShell>
  );
}
