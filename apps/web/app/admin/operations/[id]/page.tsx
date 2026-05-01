import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getOperation } from '@/lib/operations-api';
import type { PricingMode } from '@sewing/shared/operations';
import { Icon, type IconName } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { OperationEditForm } from './edit-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

const PRICING_LABEL: Record<PricingMode, string> = {
  FIXED: 'Фиксированная ставка',
  BY_SIZE: 'По размерам',
  SALARY_ONLY: 'Окладная',
};

const PRICING_ICON: Record<PricingMode, IconName> = {
  FIXED: 'price',
  BY_SIZE: 'operations',
  SALARY_ONLY: 'earnings',
};

const PRICING_MODIFIER: Record<PricingMode, string> = {
  FIXED: 'pricing-mode--fixed',
  BY_SIZE: 'pricing-mode--by-size',
  SALARY_ONLY: 'pricing-mode--salary-only',
};

const CATEGORY_LABEL: Record<string, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

const CATEGORY_ICON: Record<string, IconName> = {
  CUTTING: 'cutting',
  SEWING: 'sewing',
  QC: 'qc',
  IRONING: 'wto',
  PACKING: 'packing',
};

/**
 * Карточка операции (см. `docs/screens.md §10c`).
 *
 * Отвечает за управленческое редактирование операции и её ставок.
 * RBAC — `app/admin/layout.tsx` режет всех, кроме `ADMIN`/`SHOP_MANAGER`.
 * Backend независимо защищает `/api/operations/*` через
 * `@Roles('SHOP_MANAGER', 'ADMIN')` (см. `docs/api.md §15a`).
 */
export default async function AdminOperationDetailPage({ params }: Params) {
  let operation;
  try {
    operation = await getOperation(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const categoryLabel =
    CATEGORY_LABEL[operation.category] ?? operation.category;
  const categoryIcon = CATEGORY_ICON[operation.category] ?? 'operations';

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Операция"
        icon="operations"
        title={operation.name}
        subtitle="Управленческая карточка операции и её тарифного режима. Источник истины для зарплаты — этот блок (см. docs/domain.md §16a)."
        backHref="/admin/operations"
        backLabel="К списку операций"
        meta={
          <>
            <span>
              Код: <code>{operation.code}</code>
            </span>
            <span>·</span>
            <span>
              <Icon name={categoryIcon} size={13} /> {categoryLabel}
            </span>
          </>
        }
        badges={
          <>
            <span
              className={`pricing-mode ${PRICING_MODIFIER[operation.pricingMode]}`}
            >
              <Icon name={PRICING_ICON[operation.pricingMode]} size={14} />
              {PRICING_LABEL[operation.pricingMode]}
            </span>
            <span
              className={`pill ${operation.isActive ? 'pill--ok' : 'pill--ghost'}`}
            >
              <Icon name={operation.isActive ? 'success' : 'idle'} size={14} />
              {operation.isActive ? 'Активна' : 'Неактивна'}
            </span>
            {operation.pricingMode === 'FIXED' && operation.fixedRate !== null && (
              <span className="pill pill--accent">
                <Icon name="price" size={14} />
                {operation.fixedRate.toFixed(2)} ₽
              </span>
            )}
            {operation.pricingMode === 'BY_SIZE' && (
              <span className="pill pill--accent">
                <Icon name="operations" size={14} />
                Ставок: {operation.ratesBySize.length} / {operation.sizes.length}
              </span>
            )}
          </>
        }
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="edit" />
            Параметры операции
          </h2>
          <span className="section-header__hint">
            Код менеджер не меняет — это управленческий ID, на нём завязан pipeline.
          </span>
        </div>
        <OperationEditForm operation={operation} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="info" />
            Тарифные режимы — справка
          </h2>
        </div>
        <div className="data-list">
          <div className="data-list__item">
            <span className="data-list__label">
              <span
                className="pricing-mode pricing-mode--fixed"
                style={{ marginRight: 4 }}
              >
                <Icon name="price" size={14} /> FIXED
              </span>
            </span>
            <span className="data-list__value data-list__value--muted">
              Единая ставка за единицу. Подходит для раскроя, киперки, распошива.
            </span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">
              <span
                className="pricing-mode pricing-mode--by-size"
                style={{ marginRight: 4 }}
              >
                <Icon name="operations" size={14} /> BY_SIZE
              </span>
            </span>
            <span className="data-list__value data-list__value--muted">
              Ставка зависит от размера. Используется для оверлоков; таблица
              «размер → ставка» — в форме выше.
            </span>
          </div>
          <div className="data-list__item">
            <span className="data-list__label">
              <span
                className="pricing-mode pricing-mode--salary-only"
                style={{ marginRight: 4 }}
              >
                <Icon name="earnings" size={14} /> SALARY_ONLY
              </span>
            </span>
            <span className="data-list__value data-list__value--muted">
              Операция в pipeline есть, но сдельной ставки нет (печать лекал,
              настил, ОТК, ВТО, упаковка). Backend не создаёт OperationEntry.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
