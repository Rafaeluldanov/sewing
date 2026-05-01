import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listEquipment } from '@/lib/equipment-api';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { CreatePrinterForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание принтера (Admin UI 2.5).
 *
 * Backend / DTO не меняем. После успеха server action редиректит на
 * `/admin/printers/[id]` — менеджер сразу видит pairing-блок.
 */
export default async function AdminPrinterNewPage() {
  let equipment: readonly EquipmentSummaryDto[] = [];
  let equipmentError: string | null = null;
  try {
    equipment = await listEquipment();
  } catch (e) {
    equipmentError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список рабочих мест — привяжите позже на карточке.';
    equipment = [];
  }

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
      {equipmentError && (
        <div className="error-box" role="alert">
          {equipmentError}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreatePrinterForm equipment={equipment} />
      </AdminCard>
    </AdminPageShell>
  );
}
