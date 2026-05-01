import Link from 'next/link';
import type { ProductionCostDayDto } from '@sewing/shared/costs';
import { getProductionCost } from '@/lib/costs-api';
import { Icon, type IconName } from '@/components/icon';
import { ProductionCostChart } from './production-cost-chart';

export const dynamic = 'force-dynamic';

interface SearchParams {
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Управленческая страница «Себестоимость выпуска» (см. `docs/screens.md §17`).
 *
 * RBAC закрывает `layout.tsx` — сюда мы попадаем только под
 * `SHOP_MANAGER` или `ADMIN`. Backend (`/api/costs/production`) тоже
 * проверяет роль независимо.
 *
 * Контент:
 *   - фильтр периода (по умолчанию backend отдаёт последние 14 дней
 *     по UTC);
 *   - четыре summary-карточки: выпущено, себестоимость, ср. цена/шт,
 *     простой;
 *   - график (`ProductionCostChart`) с тремя нормированными линиями;
 *   - таблица по дням (себестоимость, оклад, сдельщина, простой,
 *     минуты).
 */
export default async function ProductionCostPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const dateFrom = (searchParams.dateFrom ?? '').trim() || undefined;
  const dateTo = (searchParams.dateTo ?? '').trim() || undefined;

  const data = await getProductionCost({ dateFrom, dateTo });

  const hasFilters = Boolean(dateFrom || dateTo);
  const summary = data.summary;

  return (
    <div className="page-shell">
      <div>
        <div className="page-eyebrow">
          <Icon name="production-cost" />
          Управленческий отчёт
        </div>
        <h1 className="page-title">
          <Icon name="production-cost" />
          Себестоимость выпуска
        </h1>
        <p className="page-subtitle">
          Себестоимость = сдельная зарплата + распределённая окладная доля
          (по длительности обработки на ОТК / ВТО / упаковке). Простой
          считается отдельно и НЕ включается в себестоимость изделия.
        </p>
        <div className="meta-line" style={{ marginTop: '0.4rem' }}>
          <Icon name="period" size={13} /> Период:{' '}
          {formatDate(data.dateFrom)} — {formatDate(data.dateTo)}.
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard
          icon="output"
          tone="ok"
          label="Выпущено"
          value={`${summary.producedUnits.toLocaleString('ru-RU')} шт`}
        />
        <KpiCard
          icon="price"
          tone="accent"
          label="Себестоимость"
          value={`${formatMoney(summary.totalCost)} ₽`}
          sub={`из них сдельщина ${formatMoney(summary.pieceworkCost)} ₽ · оклад ${formatMoney(summary.salaryCost)} ₽`}
        />
        <KpiCard
          icon="price"
          label="Себестоимость / шт"
          value={
            summary.producedUnits > 0
              ? `${formatMoney(summary.avgCostPerUnit)} ₽`
              : '—'
          }
          sub={
            summary.producedUnits > 0
              ? `${summary.trackedMinutes.toLocaleString('ru-RU')} мин учтено`
              : 'Нет выпуска за период'
          }
        />
        <KpiCard
          icon="idle"
          tone={summary.idleCost > 0 ? 'danger' : undefined}
          label="Простой"
          value={`${formatMoney(summary.idleCost)} ₽`}
          sub={`${summary.idleMinutes.toLocaleString('ru-RU')} мин неучтено`}
        />
      </div>

      <form method="get" className="filter-card">
        <div className="filter-card__field">
          <label htmlFor="dateFrom">
            <Icon name="period" size={12} /> Период
          </label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              id="dateFrom"
              name="dateFrom"
              type="date"
              defaultValue={dateFrom ?? ''}
            />
            <input
              id="dateTo"
              name="dateTo"
              type="date"
              defaultValue={dateTo ?? ''}
            />
          </div>
        </div>
        <div className="filter-card__actions">
          <button type="submit" className="btn btn-primary">
            <Icon name="filter" size={14} />
            <span style={{ marginLeft: '0.35rem' }}>Применить</span>
          </button>
          {hasFilters && (
            <Link className="btn btn-ghost" href="/production-cost">
              <Icon name="reset" size={14} />
              <span style={{ marginLeft: '0.35rem' }}>Сбросить</span>
            </Link>
          )}
        </div>
      </form>

      <div className="card">
        <div className="section-header">
          <h2>
            <Icon name="pulse" />
            Динамика по дням
          </h2>
          <span className="section-header__hint">
            Выпуск, себестоимость, простой
          </span>
        </div>
        <ProductionCostChart days={data.days} />
      </div>

      <div className="section-header" style={{ marginTop: '0.5rem' }}>
        <h2>
          <Icon name="period" />
          По дням
        </h2>
      </div>
      {data.days.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="info" />
          </span>
          <span className="empty-state__title">Нет данных</span>
          <span className="empty-state__hint">
            За выбранный период данных нет.
          </span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th style={{ textAlign: 'right' }}>Выпущено, шт</th>
              <th style={{ textAlign: 'right' }}>Себестоимость, ₽</th>
              <th style={{ textAlign: 'right' }}>Сдельщина, ₽</th>
              <th style={{ textAlign: 'right' }}>Оклад (распред.), ₽</th>
              <th style={{ textAlign: 'right' }}>Учтено, мин</th>
              <th style={{ textAlign: 'right' }}>Простой, мин</th>
              <th style={{ textAlign: 'right' }}>Простой, ₽</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <DayRow key={d.date} day={d} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DayRow({ day }: { day: ProductionCostDayDto }) {
  return (
    <tr>
      <td>{formatDate(day.date)}</td>
      <td style={{ textAlign: 'right' }}>{day.producedUnits}</td>
      <td style={{ textAlign: 'right' }}>
        <strong>{formatMoney(day.totalCost)}</strong>
      </td>
      <td style={{ textAlign: 'right' }}>{formatMoney(day.pieceworkCost)}</td>
      <td style={{ textAlign: 'right' }}>{formatMoney(day.salaryCost)}</td>
      <td style={{ textAlign: 'right' }}>{day.trackedMinutes}</td>
      <td style={{ textAlign: 'right' }}>{day.idleMinutes}</td>
      <td style={{ textAlign: 'right', color: day.idleCost > 0 ? 'var(--color-danger-fg)' : undefined }}>
        {formatMoney(day.idleCost)}
      </td>
    </tr>
  );
}

type KpiTone = 'ok' | 'warn' | 'danger' | 'accent';
function KpiCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
}) {
  const cls = `kpi-card${tone ? ` kpi-card--${tone}` : ''}`;
  return (
    <div className={cls}>
      <div className="kpi-card__head">
        <span className="kpi-card__icon">
          <Icon name={icon} />
        </span>
        {label}
      </div>
      <div className="kpi-card__value">{value}</div>
      {sub && <div className="kpi-card__sub">{sub}</div>}
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatMoney(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
