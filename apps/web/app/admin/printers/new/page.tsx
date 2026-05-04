import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreatePrinterForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание принтера. После успеха server action редиректит на
 * `/admin/printers/[id]` — менеджер сразу видит pairing-блок.
 *
 * Привязка идёт по роли сотрудника (`Printer.role`). Список
 * рабочих мест (Equipment) больше не загружается: он не нужен
 * новой UI-модели и убран вместе со старым полем формы.
 */
export default async function AdminPrinterNewPage() {
  return (
    <AdminPageShell
      icon={<Printer size={22} strokeWidth={1.6} aria-hidden />}
      title="Новый принтер"
      actions={
        <Link href="/admin/printers" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreatePrinterForm />
      </AdminCard>
    </AdminPageShell>
  );
}
