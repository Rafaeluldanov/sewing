/**
 * Статьи ДДС (`/admin/treasury/items`, Фаза 0).
 *
 * Классификатор проводок журнала движения ДС. Backend:
 * `GET/POST /api/treasury/items`, `PATCH /api/treasury/items/:id`.
 */
import Link from 'next/link';
import { ArrowLeft, ListTree } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listCashFlowItems } from '@/lib/treasury-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { ItemsManager } from './items-manager';

export const dynamic = 'force-dynamic';

export default async function TreasuryItemsPage() {
  let items: Awaited<ReturnType<typeof listCashFlowItems>> = [];
  let error: string | null = null;
  try {
    items = await listCashFlowItems({});
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить статьи ДДС';
  }

  return (
    <AdminPageShell
      icon={<ListTree size={22} strokeWidth={1.6} aria-hidden />}
      title="Статьи ДДС"
      subtitle="Классификатор проводок движения ДС"
      actions={
        <Link href="/admin/treasury" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К журналу
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <AdminCard>
        <AdminSectionHeader title="Статьи" hint={`${items.length}`} />
        <ItemsManager items={items} />
      </AdminCard>
    </AdminPageShell>
  );
}
