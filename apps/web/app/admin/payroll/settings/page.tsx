import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
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
 * Экран — навигационный hub: сам он ничего не хранит, все «ручки»
 * управления живут в профильных разделах админки. Исключение одно —
 * производственный календарь (29.07.2026): он появился вместе с
 * месячным окладом и не относится ни к операциям, ни к сотрудникам,
 * поэтому живёт своим экраном внутри «Зарплаты».
 *
 *   - ставки операций (`Operation.fixedRate` / `OperationRateBySize`,
 *     ADR-0020) — `/admin/operations`;
 *   - окладная ставка сотрудника — вид (часовой / месячный) и сама
 *     сумма (`Employee.salaryRateMode` + `salaryPerHour` /
 *     `salaryPerMonth`, ADR-0021) — `/admin/employees`;
 *   - норма дней/часов месяца (`PayrollCalendarMonth`) —
 *     `/admin/payroll/calendar`;
 *   - подразделения для группировок и UI-фильтров —
 *     `/admin/company-settings` (см. `docs/domain.md
 *     §«Подразделения заказа»`).
 */
export default function AdminPayrollSettingsPage() {
  return (
    <AdminPageShell
      icon={<SettingsIcon size={22} strokeWidth={1.6} aria-hidden />}
      title="Настройки зарплаты"
      subtitle="Ставки и тарифы — в профильных разделах, календарь — здесь"
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
          Ведомость зарплаты работает на чтение и агрегирует данные из
          существующих контуров, поэтому формы ставок не дублируем —
          ссылки ведут в разделы, где эти значения ведутся.
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
              hint="Вид оклада (часовой / месячный), ставка и compensationType (ADR-0021)"
            />
          </li>
          <li>
            <SettingsLink
              icon={<CalendarDays size={18} strokeWidth={1.6} aria-hidden />}
              href="/admin/payroll/calendar"
              title="Производственный календарь"
              hint="Норма дней и часов месяца — знаменатель ставки ₽/час у месячного оклада"
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
