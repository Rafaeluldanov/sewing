/**
 * `PatternPreviewCard` — превью лекала / номенклатуры в карточке заказа.
 *
 * Soft-pattern MVP (этап 2 «Лекала», см.
 * `docs/recon-soft-integration.md §«План внедрения»`,
 * `prisma/schema.prisma::Order.patternItemId`,
 * `apps/api/src/modules/orders/orders.service.ts`).
 *
 * Один компонент покрывает все четыре состояния заказа. Источник
 * имени/артикула/превью выбирает единый resolver
 * `resolveOrderNomenclature` (см. `apps/web/lib/order-nomenclature.ts`):
 *
 *   - `'snapshot'`     → snapshot-поля (`patternNameSnapshot` /
 *                        `patternArticleSnapshot` /
 *                        `patternPreviewSnapshotUrl`). Это «лекало по
 *                        которому заказ ушёл в работу»; даже если
 *                        карточку лекала позже переименовали или
 *                        удалили, заказ продолжает показывать
 *                        зафиксированное имя. На карточке рисуем
 *                        бейдж «снимок».
 *   - `'pattern'`      → live-поля карточки лекала (DRAFT-заказ
 *                        с `patternItemId`, snapshot ещё нет).
 *                        Бейдж «актуальное» + ссылка на карточку
 *                        лекала.
 *   - `'legacyProduct'` → snapshot/lекало нет, но есть legacy
 *                         `productName`. Это исторические заказы
 *                         без `PatternItem`; превью у legacy Product
 *                         не бывает, артикул тоже не показываем.
 *                         Бейдж «legacy» помогает менеджеру понять
 *                         источник.
 *   - `'none'`         → ничего нет, рисуем placeholder «не выбрано».
 *
 * Importantly: блок «Изделие» в `apps/web/app/admin/orders/[id]/page.tsx`
 * пользуется ТЕМ ЖЕ resolver-ом, поэтому preview и блок «Изделие»
 * в одной и той же карточке всегда показывают одно и то же
 * название/артикул/превью.
 *
 * Никаких action-кнопок: смена лекала живёт на форме редактирования
 * заказа (`/admin/orders/[id]/edit`), здесь — только просмотр.
 *
 * Layout: компактный 2-колоночный блок (превью 96×96 + текст).
 * Размещение в карточке заказа — правый верхний угол (`admin-grid-2`
 * / `actions`-слот), при узком экране уходит под основную колонку.
 */
import Link from 'next/link';
import {
  ORDER_NOMENCLATURE_SOURCE_BADGE,
  resolveOrderNomenclature,
  type OrderNomenclatureSource,
  type OrderNomenclatureSourceTag,
} from '@/lib/order-nomenclature';
import { AdminCard } from '@/components/admin';

interface Props {
  /**
   * Минимальный набор полей `OrderDetailDto`, который нужен resolver-у
   * + `patternItemId` для ссылки на карточку лекала.
   */
  order: OrderNomenclatureSource;
  /**
   * Стиль вёрстки. По умолчанию — `admin` (использует `AdminCard` и
   * admin-design-system); `legacy` — лёгкая вёрстка для старой карточки
   * `/orders/[id]` без admin-стилей.
   */
  variant?: 'admin' | 'legacy';
}

/**
 * Заголовок карточки превью. Раньше зависел только от наличия
 * snapshot-а, теперь явно отражает источник. Для legacy-заказов
 * показываем «Изделие», чтобы менеджер не путался — карточки
 * лекала тут нет, и слово «Лекало» было бы вводящим в заблуждение.
 */
function titleFor(source: OrderNomenclatureSourceTag): string {
  switch (source) {
    case 'snapshot':
      return 'Лекало (снимок)';
    case 'pattern':
      return 'Лекало';
    case 'legacyProduct':
      return 'Изделие';
    case 'none':
    default:
      return 'Лекало';
  }
}

export function PatternPreviewCard({ order, variant = 'admin' }: Props) {
  const r = resolveOrderNomenclature(order);
  const isAdmin = variant === 'admin';
  const titleText = titleFor(r.source);
  const sourceBadge = ORDER_NOMENCLATURE_SOURCE_BADGE[r.source];

  // Ссылка на карточку лекала живёт только пока есть live `patternItemId`
  // (snapshot или live PatternItem). Для legacy-заказов без
  // `patternItemId` ссылки нет — Product сознательно скрыт.
  const patternHref =
    (r.source === 'snapshot' || r.source === 'pattern') && order.patternItemId
      ? `/admin/patterns/${order.patternItemId}`
      : null;

  // Цвет бейджа: snapshot — фиолетовый, pattern — зелёный, legacy —
  // нейтральный серый. UI карточки заказа подсвечивает «снимок» и
  // «актуальное» как «активное» состояние, а «legacy» — как
  // вспомогательный indicator-of-origin.
  const badgeBackground =
    r.source === 'snapshot'
      ? 'rgba(99, 102, 241, 0.12)'
      : r.source === 'pattern'
        ? 'rgba(34, 197, 94, 0.12)'
        : 'rgba(148, 163, 184, 0.18)';
  const badgeColor =
    r.source === 'snapshot'
      ? '#4338ca'
      : r.source === 'pattern'
        ? '#15803d'
        : 'rgba(0, 0, 0, 0.55)';

  const body = (
    <div
      style={{
        display: 'flex',
        gap: '0.75rem',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          flex: '0 0 96px',
          borderRadius: 8,
          background: '#f3f4f6',
          border: '1px solid rgba(0,0,0,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          fontSize: '0.78rem',
          color: 'rgba(0,0,0,0.5)',
        }}
      >
        {r.previewImageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={r.previewImageUrl}
            alt={r.name ?? 'Превью лекала'}
            width={96}
            height={96}
            style={{
              width: 96,
              height: 96,
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : r.source === 'none' ? (
          <span>не выбрано</span>
        ) : (
          <span>без превью</span>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.2rem',
          minWidth: 0,
          flex: '1 1 auto',
        }}
      >
        <div
          style={{
            fontSize: '0.78rem',
            color: isAdmin
              ? 'var(--admin-muted-fg, rgba(0,0,0,0.55))'
              : 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span>{titleText}</span>
          {sourceBadge && (
            <span
              style={{
                fontSize: '0.7rem',
                padding: '1px 6px',
                borderRadius: 999,
                background: badgeBackground,
                color: badgeColor,
              }}
            >
              {sourceBadge}
            </span>
          )}
        </div>

        {r.source === 'none' ? (
          <strong style={{ fontSize: '0.95rem', fontWeight: 500 }}>
            <span
              style={{
                color: isAdmin
                  ? 'var(--admin-muted-fg, rgba(0,0,0,0.55))'
                  : 'rgba(0,0,0,0.55)',
              }}
            >
              Не выбрано
            </span>
          </strong>
        ) : (
          <>
            <strong
              style={{
                fontSize: '0.95rem',
                fontWeight: 600,
                wordBreak: 'break-word',
              }}
            >
              {patternHref ? (
                <Link
                  href={patternHref}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  {r.name ?? '—'}
                </Link>
              ) : (
                (r.name ?? '—')
              )}
            </strong>
            {r.article && (
              <span
                style={{
                  fontSize: '0.82rem',
                  color: isAdmin
                    ? 'var(--admin-muted-fg, rgba(0,0,0,0.55))'
                    : 'rgba(0,0,0,0.55)',
                }}
              >
                Артикул: {r.article}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (isAdmin) {
    return (
      <AdminCard className="admin-pattern-preview" compact>
        {body}
      </AdminCard>
    );
  }
  return (
    <div className="card" style={{ margin: 0 }}>
      {body}
    </div>
  );
}
