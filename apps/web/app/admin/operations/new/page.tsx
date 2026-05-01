import Link from 'next/link';
import { ArrowLeft, Scissors } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listEquipment } from '@/lib/equipment-api';
import { CreateOperationForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание операции (Admin UI 2.5, ADR-0020).
 *
 * Backend / DTO не меняем. После создания server action редиректит на
 * `/admin/operations/[id]` — там донастраиваются ставки `BY_SIZE`.
 */
export default async function AdminOperationNewPage() {
  const equipment = (await listEquipment())
    .filter((eq) => eq.active)
    .slice()
    .sort((a, b) => {
      const an = a.displayNumber ?? '';
      const bn = b.displayNumber ?? '';
      if (an && bn && an !== bn) return an.localeCompare(bn, 'ru');
      return a.name.localeCompare(b.name, 'ru');
    });

  return (
    <AdminPageShell
      icon={<Scissors size={22} strokeWidth={1.6} aria-hidden />}
      title="Новая операция"
      subtitle="Код, название, категория и тариф"
      actions={
        <Link href="/admin/operations" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Параметры"
          hint="Ставки BY_SIZE задаются на карточке"
        />
        <CreateOperationForm equipment={equipment} />
      </AdminCard>
    </AdminPageShell>
  );
}
