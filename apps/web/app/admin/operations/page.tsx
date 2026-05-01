import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listOperations } from '@/lib/operations-api';
import type {
  OperationSummaryDto,
  PricingMode,
} from '@sewing/shared/operations';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

const PRICING_LABEL: Record<PricingMode, string> = {
  FIXED: 'Фиксированная',
  BY_SIZE: 'По размерам',
  SALARY_ONLY: 'Оклад',
};

function formatRate(op: OperationSummaryDto): React.ReactNode {
  if (op.pricingMode === 'FIXED') {
    return op.fixedRate !== null ? (
      <strong>{op.fixedRate.toFixed(2)} ₽</strong>
    ) : (
      <span className="meta-line" title="FIXED-операция без ставки — заполните в карточке">
        —
      </span>
    );
  }
  if (op.pricingMode === 'BY_SIZE') {
    return op.ratesBySizeCount > 0 ? (
      <span title="Ставки заданы по размерам">
        ставок: <strong>{op.ratesBySizeCount}</strong>
      </span>
    ) : (
      <span className="meta-line" title="BY_SIZE без ставок — заполните в карточке">
        не задано
      </span>
    );
  }
  return <span className="meta-line">не применяется</span>;
}

/**
 * Список операций (см. `docs/screens.md §10c`).
 *
 * Источник истины — `GET /api/operations` (роли `ADMIN`/`SHOP_MANAGER`).
 * Доступ к разделу режется выше — `app/admin/layout.tsx` редиректит
 * всех, кроме `ADMIN`/`SHOP_MANAGER`. Backend дополнительно
 * защищает `/api/operations/*` через `@Roles('SHOP_MANAGER', 'ADMIN')`.
 *
 * Создание новой операции вынесено на отдельную страницу
 * `/admin/operations/new` — раньше форма жила прямо в списке и
 * визуально его перегружала. На списке остаётся только заметная
 * primary-кнопка «Добавить операцию» в actions шапки. Тот же UX
 * уже применён к `/admin/equipment` (см. ADR-0017).
 */
export default async function AdminOperationsListPage() {
  let items: OperationSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listOperations();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список операций';
  }

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="operations" />
            Тарифы
          </div>
          <h1 className="page-title">
            <Icon name="operations" />
            Операции
          </h1>
          <p className="page-subtitle">
            Управленческий блок: тарифные режимы и ставки. Источник истины
            для зарплаты — этот раздел (см. docs/domain.md §16a). Создание
            новой операции — на отдельной странице.
          </p>
        </div>
        <div className="admin-overview__actions">
          <Link href="/admin/operations/new" className="btn btn-primary">
            <Icon name="plus" size={16} />
            Добавить операцию
          </Link>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {items.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Icon name="operations" />
          </span>
          <span className="empty-state__title">Пока нет операций</span>
          <span className="empty-state__hint">
            <Link href="/admin/operations/new">Создайте первую операцию</Link> —
            это займёт меньше минуты.
          </span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Код</th>
              <th>Категория</th>
              <th>Тариф</th>
              <th>Ставка</th>
              <th>Активна</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((op) => (
              <tr key={op.id}>
                <td>
                  <strong>{op.name}</strong>
                </td>
                <td>
                  <code>{op.code}</code>
                </td>
                <td>{CATEGORY_LABEL[op.category] ?? op.category}</td>
                <td>{PRICING_LABEL[op.pricingMode]}</td>
                <td>{formatRate(op)}</td>
                <td>
                  {op.isActive ? 'да' : <span className="meta-line">нет</span>}
                </td>
                <td>
                  <Link href={`/admin/operations/${op.id}`}>
                    Открыть <Icon name="arrow-right" size={13} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
