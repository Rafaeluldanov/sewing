import Link from 'next/link';
import { ArrowLeft, MonitorSmartphone } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { CreateDisplayScreenForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание display-экрана (Admin UI 2.5).
 *
 * PHASE 1 «CompanyDivision как master-справочник» (см.
 * `docs/domain.md §«Подразделения заказа»»): подгружаем активные
 * карточки подразделений, чтобы форма выводила select по
 * `CompanyDivision`. Если список пуст (новая инсталляция без seed-а),
 * форма fallback-ит на legacy enum-select.
 */
export default async function AdminDisplayScreenNewPage() {
  let companyDivisions: CompanyDivisionDto[] = [];
  try {
    companyDivisions = await listCompanyDivisions();
  } catch {
    companyDivisions = [];
  }

  return (
    <AdminPageShell
      icon={<MonitorSmartphone size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый display-экран"
      subtitle="Логин-учётка + конфиг для /shopfloor/display"
      actions={
        <Link
          href="/admin/display-screens"
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Параметры"
          hint="PIN не восстановить — запишите сразу"
        />
        <CreateDisplayScreenForm companyDivisions={companyDivisions} />
      </AdminCard>
    </AdminPageShell>
  );
}
