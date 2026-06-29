import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Scissors,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

/**
 * Настройки модуля «Зарплата» (PHASE 1, MVP).
 *
 * PHASE 1 сознательно НЕ заводит новых настроек: payroll API —
 * read-only агрегатор поверх уже существующих сущностей. Все «ручки»
 * управления уже живут в других разделах админки:
 *
 *   - ставки операций (`Operation.fixedRate` / `OperationRateBySize`,
 *     ADR-0020) — `/admin/operations`;
 *   - почасовая окладная ставка (`Employee.salaryPerHour`,
 *     ADR-0021) — `/admin/employees`;
 *   - подразделения для группировок и UI-фильтров —
 *     `/admin/company-settings` (см. `docs/domain.md
 *     §«Подразделения заказа»`).
 *
 * Этот экран — навигационный hub на эти три секции, чтобы менеджеру
 * было одно место «настройки зарплаты», без новых полей и без
 * дублирования форм. PHASE 2 при необходимости заменит его на
 * полноценные payroll-настройки (ledger, lock, manual entries).
 */
export default function AdminPayrollSettingsPage() {
  return (
    <AdminPageShell
      icon={<SettingsIcon size={22} strokeWidth={1.6} aria-hidden />}
      title="Настройки зарплаты"
      subtitle="PHASE 1 — все ставки и тарифы живут в существующих разделах"
      actions={
        <Link href="/admin/payroll" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К ведомости
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Где править" />
        <p className="admin-muted" style={{ marginBottom: '0.75rem' }}>
          В PHASE 1 модуль «Зарплата» работает только на чтение и
          агрегирует данные из уже существующих контуров. Никаких
          новых настроек на этой странице сознательно не заводим — это
          избавит от дублей форм и расхождений значений.
        </p>
        <ul className="admin-deflist">
          <li>
            <SettingsLink
              icon={<Scissors size={18} strokeWidth={1.6} aria-hidden />}
              href="/admin/operations"
              title="Ставки операций"
              hint="Тариф сдельщины: FIXED / BY_SIZE / SALARY_ONLY (ADR-0020)"
            />
          </li>
          <li>
            <SettingsLink
              icon={<Users size={18} strokeWidth={1.6} aria-hidden />}
              href="/admin/employees"
              title="Ставки сотрудников"
              hint="Почасовая ставка (Employee.salaryPerHour) и compensationType (ADR-0021)"
            />
          </li>
          <li>
            <SettingsLink
              icon={<Building2 size={18} strokeWidth={1.6} aria-hidden />}
              href="/admin/company-settings"
              title="Подразделения и реквизиты"
              hint="CompanyDivision — фильтр ведомости и заказов"
            />
          </li>
        </ul>
      </AdminCard>
    </AdminPageShell>
  );
}

function SettingsLink({
  icon,
  href,
  title,
  hint,
}: {
  icon: React.ReactNode;
  href: string;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.6rem 0.75rem',
        borderRadius: 8,
        border: '1px solid var(--admin-border, #e5e7eb)',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <span aria-hidden>{icon}</span>
      <span style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {hint}
        </div>
      </span>
      <ArrowRight size={16} strokeWidth={1.6} aria-hidden />
    </Link>
  );
}
