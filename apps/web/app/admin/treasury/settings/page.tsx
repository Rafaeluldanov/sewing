/**
 * Настройки казначейства (`/admin/treasury/settings`, Фаза 1).
 *
 * «Зарплатный» счёт и статья ДДС по умолчанию: при их наличии выдача
 * `PayrollPayout` пишет расходную проводку журнала ДС (опт-ин). Backend:
 * `GET/PUT /api/treasury/settings`.
 */
import Link from 'next/link';
import { ArrowLeft, Settings } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getTreasurySettings,
  listCashAccounts,
  listCashFlowItems,
} from '@/lib/treasury-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { SettingsForm } from './settings-form';

export const dynamic = 'force-dynamic';

export default async function TreasurySettingsPage() {
  let error: string | null = null;
  let settings: Awaited<ReturnType<typeof getTreasurySettings>> = {
    salaryAccountId: null,
    salaryAccountName: null,
    salaryItemId: null,
    salaryItemName: null,
  };
  let accounts: Awaited<ReturnType<typeof listCashAccounts>> = [];
  let items: Awaited<ReturnType<typeof listCashFlowItems>> = [];

  try {
    [settings, accounts, items] = await Promise.all([
      getTreasurySettings(),
      listCashAccounts({ activeOnly: true }),
      listCashFlowItems({ activeOnly: true }),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить настройки казначейства';
  }

  return (
    <AdminPageShell
      icon={<Settings size={22} strokeWidth={1.6} aria-hidden />}
      title="Настройки казначейства"
      subtitle="Параметры автопроводок"
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
        <AdminSectionHeader title="Зарплата" hint="автопроводка при выдаче" />
        <SettingsForm settings={settings} accounts={accounts} items={items} />
      </AdminCard>
    </AdminPageShell>
  );
}
