/**
 * Счета ДС (`/admin/treasury/accounts`, Фаза 0).
 *
 * Касса и расчётные счета — единая таблица `CashAccount` с
 * дискриминатором `kind`. Backend: `GET/POST /api/treasury/accounts`,
 * `PATCH /api/treasury/accounts/:id`.
 */
import Link from 'next/link';
import { ArrowLeft, Banknote } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listCashAccounts } from '@/lib/treasury-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { AccountsManager } from './accounts-manager';

export const dynamic = 'force-dynamic';

export default async function TreasuryAccountsPage() {
  let accounts: Awaited<ReturnType<typeof listCashAccounts>> = [];
  let error: string | null = null;
  try {
    accounts = await listCashAccounts({});
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить счета';
  }

  return (
    <AdminPageShell
      icon={<Banknote size={22} strokeWidth={1.6} aria-hidden />}
      title="Счета ДС"
      subtitle="Касса и расчётные счета"
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
        <AdminSectionHeader title="Счета" hint={`${accounts.length}`} />
        <AccountsManager accounts={accounts} />
      </AdminCard>
    </AdminPageShell>
  );
}
