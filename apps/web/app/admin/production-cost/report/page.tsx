/**
 * Страница «Отчёт» внутри раздела «Себестоимость»
 * (`/admin/production-cost/report`).
 *
 * Компактная сводка за период из двух показателей:
 *
 *   - **Себестоимость** — фактическая сумма, потраченная на изготовление
 *     продукции: материалы (расчёт) + фурнитура + нанесение + прочее +
 *     сдельная (факт начислений) + окладная «рабочая» часть (разнесённое
 *     реальное время окладников × ставка);
 *   - **Простой** — окладная часть, не ушедшая в работу:
 *     `Σ max(0, 480 − разнесённое) × (оклад/480)` по окладникам со сменой
 *     (`SalaryEntry`) за день.
 *
 * Под каждым показателем — расшифровка по составляющим. Источник —
 * тот же endpoint `GET /api/admin/production-cost/v2`, что и у полного
 * отчёта (`../page.tsx`); считается окладной разнос в
 * `ProductionCostV2Service.computeSalarySplit`.
 */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { CalendarRange, Filter, RotateCcw, Tag, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ProductionCostTotalsDto } from '@sewing/shared/production-cost';
import { getProductionCostV2 } from '@/lib/production-cost-api';
import {
  AdminCard,
  AdminDateField,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

interface SearchParams {
  dateFrom?: string;
  dateTo?: string;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatMoney(value: string | number | null): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatMinutes(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('ru-RU');
}

const subLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--admin-muted)',
};

export default async function ProductionCostReportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const dateFrom = (searchParams.dateFrom ?? '').trim() || undefined;
  const dateTo = (searchParams.dateTo ?? '').trim() || undefined;
  const hasFilters = Boolean(dateFrom || dateTo);

  let totals: ProductionCostTotalsDto | null = null;
  let period: { from: string; to: string } | null = null;
  let error: string | null = null;
  try {
    const data = await getProductionCostV2({ dateFrom, dateTo });
    totals = data.totals;
    period = { from: data.dateFrom, to: data.dateTo };
  } catch (e) {
    error =
      e instanceof Error ? e.message : 'Не удалось загрузить отчёт';
  }

  // Себестоимость = totalCostRub (материалы + фурнитура + нанесение +
  // прочее + сделка) + окладная рабочая часть (в totalCostRub оклад не
  // входит — он не распределяется по номенклатуре в v2).
  const cost = totals
    ? Number(totals.totalCostRub) + Number(totals.salaryWorkingCostRub)
    : 0;
  const idle = totals ? Number(totals.idleSalaryCostRub) : 0;

  return (
    <AdminPageShell
      icon={<Tag size={22} strokeWidth={1.6} aria-hidden />}
      title="Отчёт"
      subtitle="Себестоимость и простой за период"
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/admin/production-cost" className="admin-btn admin-btn--ghost">
            ← К себестоимости
          </Link>
          <Link href="/production-cost" className="admin-btn admin-btn--ghost">
            Дневной отчёт цеха
          </Link>
        </div>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {totals && period && (
        <>
          <AdminCard compact>
            <div className="admin-section-header">
              <h2 className="admin-section-title">
                <CalendarRange size={16} strokeWidth={1.6} aria-hidden />
                Период: {formatDate(period.from)} — {formatDate(period.to)}
              </h2>
            </div>
            <form method="get" className="admin-form-grid">
              <div className="admin-field">
                <label htmlFor="dateFrom">С даты</label>
                <AdminDateField
                  id="dateFrom"
                  name="dateFrom"
                  defaultValue={dateFrom ?? ''}
                />
              </div>
              <div className="admin-field">
                <label htmlFor="dateTo">По дату</label>
                <AdminDateField
                  id="dateTo"
                  name="dateTo"
                  defaultValue={dateTo ?? ''}
                />
              </div>
              <div
                className="admin-field admin-field--inline"
                style={{ alignSelf: 'end' }}
              >
                <button type="submit" className="admin-btn admin-btn--primary">
                  <Filter size={14} strokeWidth={1.6} aria-hidden />
                  Применить
                </button>
                {hasFilters && (
                  <Link
                    href="/admin/production-cost/report"
                    className="admin-btn admin-btn--ghost"
                  >
                    <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
                    Сбросить
                  </Link>
                )}
              </div>
            </form>
          </AdminCard>

          <section aria-label="Сводка" className="admin-stack">
            <div className="admin-kpi-grid">
              <BigStat
                tone="purple"
                Icon={Tag}
                label="Себестоимость"
                value={`${formatMoney(cost)} ₽`}
                hint="Фактически потрачено на изготовление"
              />
              <BigStat
                tone="orange"
                Icon={Timer}
                label="Простой"
                value={`${formatMoney(idle)} ₽`}
                hint={`${formatMinutes(totals.idleSalaryMinutes)} мин по окладу`}
              />
            </div>
          </section>

          <CostBreakdown totals={totals} cost={cost} />
          <IdleBreakdown totals={totals} idle={idle} />
        </>
      )}
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// Расшифровка
// ---------------------------------------------------------------------------

function CostBreakdown({
  totals,
  cost,
}: {
  totals: ProductionCostTotalsDto;
  cost: number;
}) {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Материалы', value: totals.materialCostRub },
    { label: 'Фурнитура', value: totals.hardwareCostRub },
    { label: 'Нанесение', value: totals.applicationCostRub },
    { label: 'Прочее', value: totals.otherCostRub },
    { label: 'Сдельная (операции)', value: totals.operationPieceworkCostRub },
    { label: 'Оклад (рабочая часть)', value: totals.salaryWorkingCostRub },
  ];
  return (
    <AdminCard>
      <AdminSectionHeader
        title="Расшифровка: Себестоимость"
        hint="Из чего складывается сумма на изготовление"
      />
      <div
        style={{ fontSize: 12, color: 'var(--admin-muted)', marginBottom: 8 }}
      >
        Материалы / фурнитура / нанесение — расчётная основа (по завершённому
        расчёту или текущей потребности). Сдельная — факт начислений
        (`OperationEntry.amount`, APPROVED). Оклад (рабочая часть) —
        разнесённое реальное время окладников × ставка.
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Составляющая</th>
              <th style={{ textAlign: 'right' }}>Сумма, ₽</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td data-label="Составляющая">{r.label}</td>
                <td data-label="Сумма" style={{ textAlign: 'right' }}>
                  {formatMoney(r.value)}
                </td>
              </tr>
            ))}
            <tr>
              <td data-label="Составляющая">
                <strong>Итого себестоимость</strong>
              </td>
              <td data-label="Сумма" style={{ textAlign: 'right' }}>
                <strong>{formatMoney(cost)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

function IdleBreakdown({
  totals,
  idle,
}: {
  totals: ProductionCostTotalsDto;
  idle: number;
}) {
  return (
    <AdminCard>
      <AdminSectionHeader
        title="Расшифровка: Простой"
        hint="Окладная часть, не ушедшая в работу"
      />
      <div
        style={{ fontSize: 12, color: 'var(--admin-muted)', marginBottom: 8 }}
      >
        Простой = Σ max(0, 480 − разнесённое время) × (оклад / 480) по
        окладникам, у кого за день есть отметка о смене (`SalaryEntry`). Смена
        = 480 минут.
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Показатель</th>
              <th style={{ textAlign: 'right' }}>Значение</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="Показатель">
                Рабочее (разнесённое) время
                <span style={subLabelStyle}>
                  оплачено и учтено в себестоимости
                </span>
              </td>
              <td data-label="Значение" style={{ textAlign: 'right' }}>
                {formatMinutes(totals.salaryWorkingMinutes)} мин
              </td>
            </tr>
            <tr>
              <td data-label="Показатель">
                Время простоя
                <span style={subLabelStyle}>480 × смены − рабочее время</span>
              </td>
              <td data-label="Значение" style={{ textAlign: 'right' }}>
                {formatMinutes(totals.idleSalaryMinutes)} мин
              </td>
            </tr>
            <tr>
              <td data-label="Показатель">
                <strong>Сумма простоя</strong>
                <span style={subLabelStyle}>
                  время простоя × ставка (оклад / 480)
                </span>
              </td>
              <td data-label="Значение" style={{ textAlign: 'right' }}>
                <strong>{formatMoney(idle)} ₽</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

interface BigStatProps {
  tone: 'blue' | 'green' | 'orange' | 'purple';
  Icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
}

const KPI_CARD_TONE: Record<BigStatProps['tone'], string> = {
  blue: 'admin-kpi-card--blue',
  green: 'admin-kpi-card--green',
  orange: 'admin-kpi-card--orange',
  purple: 'admin-kpi-card--purple',
};

const KPI_BUBBLE_TONE: Record<BigStatProps['tone'], string> = {
  blue: 'admin-accent-blue',
  green: 'admin-accent-green',
  orange: 'admin-accent-orange',
  purple: 'admin-accent-purple',
};

function BigStat({ tone, Icon, label, value, hint }: BigStatProps) {
  return (
    <div className={`admin-kpi-card ${KPI_CARD_TONE[tone]}`}>
      <div className="admin-kpi-card__head">
        <span
          className={`admin-kpi-card__bubble ${KPI_BUBBLE_TONE[tone]}`}
          aria-hidden
        >
          <Icon size={16} strokeWidth={1.6} />
        </span>
        {label}
      </div>
      <div className="admin-kpi-card__value">{value}</div>
      {hint && <div className="admin-kpi-card__sub">{hint}</div>}
    </div>
  );
}
