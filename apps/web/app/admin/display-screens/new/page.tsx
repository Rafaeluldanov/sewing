import Link from 'next/link';
import { ArrowLeft, MonitorSmartphone } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreateDisplayScreenForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание display-экрана (Admin UI 2.5).
 *
 * Backend / DTO не меняем. Создаёт пару «DISPLAY-учётка + конфиг
 * подразделения» одной транзакцией.
 */
export default function AdminDisplayScreenNewPage() {
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
        <CreateDisplayScreenForm />
      </AdminCard>
    </AdminPageShell>
  );
}
