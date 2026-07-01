import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, BadgeRussianRuble } from 'lucide-react';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listPayrollPayouts } from '@/lib/payroll-payouts-api';
import type { PayrollPayoutDto } from '@sewing/shared/payroll-payouts';

export const dynamic = 'force-dynamic';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

function statusLabel(status: PayrollPayoutDto['status']): string {
  switch (status) {
    case 'DRAFT':
      return 'Черновик';
    case 'ISSUED':
      return 'Ожидает подтверждения';
    case 'ACKNOWLEDGED':
      return 'Получено';
    case 'CANCELLED':
      return 'Отменено';
  }
}

function statusStyle(status: PayrollPayoutDto['status']): React.CSSProperties {
  switch (status) {
    case 'ISSUED':
      return { background: '#fef9c3', color: '#854d0e', border: '1px solid #fde047' };
    case 'ACKNOWLEDGED':
      return { background: '#e4f4e6', color: '#2f7d4e', border: '1px solid #a9d9b5' };
    case 'CANCELLED':
      return { background: '#f1f1ef', color: '#5f5f5c', border: '1px solid #d4d4d0' };
    default:
      return { background: '#f1f1ef', color: '#374151', border: '1px solid #d4d4d0' };
  }
}

import type React from 'react';

/**
 * Список выплат сотрудника (PHASE 3 STEP 5).
 *
 * Backend автоматически ограничивает список выплатами текущего
 * сотрудника. Сотрудник видит только свои выплаты.
 */
export default async function EmployeePayoutsPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/earnings/payouts');

  let items: PayrollPayoutDto[] = [];
  let loadError: string | null = null;

  try {
    const response = await listPayrollPayouts({ pageSize: 100 });
    items = response.items;
  } catch {
    loadError = 'Не удалось загрузить список выплат';
  }

  const hasIssued = items.some((p) => p.status === 'ISSUED');

  return (
    <div className="page-shell">
      <div>
        <div className="page-eyebrow">
          <BadgeRussianRuble size={18} strokeWidth={1.6} aria-hidden />
          Мои выплаты
        </div>
        <h1 className="page-title">Мои выплаты</h1>
        <p className="page-subtitle">
          Здесь отображаются выплаты зарплаты, начисленные вам за период.
        </p>
      </div>

      {hasIssued && (
        <div
          role="alert"
          style={{
            background: '#fef9c3',
            border: '1px solid #fde047',
            borderRadius: '0.5rem',
            padding: '0.875rem 1rem',
            color: '#854d0e',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontWeight: 500,
          }}
        >
          <BadgeRussianRuble size={18} strokeWidth={1.6} aria-hidden />
          У вас есть выплаты, ожидающие подтверждения
        </div>
      )}

      {loadError && (
        <div className="error-box" role="alert">
          {loadError}
        </div>
      )}

      {items.length === 0 && !loadError ? (
        <div className="card empty">
          Выплат пока нет. Они появятся после того, как менеджер создаст и
          передаст вам выплату.
        </div>
      ) : (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          {items.map((payout) => (
            <Link
              key={payout.id}
              href={`/earnings/payouts/${payout.id}`}
              style={{ textDecoration: 'none' }}
            >
              <div
                className="card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  cursor: 'pointer',
                  transition: 'box-shadow 0.15s',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                    {formatDate(payout.periodFrom)} —{' '}
                    {formatDate(payout.periodTo)}
                  </div>
                  <div
                    style={{
                      fontSize: '1.25rem',
                      fontWeight: 700,
                      color: '#111827',
                    }}
                  >
                    {formatRub(payout.amountTotalRub)}
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                  }}
                >
                  <span
                    style={{
                      ...statusStyle(payout.status),
                      borderRadius: '9999px',
                      padding: '0.25rem 0.75rem',
                      fontSize: '0.8rem',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {statusLabel(payout.status)}
                  </span>
                  <ArrowRight
                    size={18}
                    strokeWidth={1.6}
                    style={{ color: '#9ca3af' }}
                    aria-hidden
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        <Link href="/earnings" className="btn btn-ghost">
          ← К начислениям
        </Link>
      </div>
    </div>
  );
}
