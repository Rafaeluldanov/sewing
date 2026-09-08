/**
 * `OrderProductionDocumentSection` — блок «Документ выпуска» во вкладке
 * «Производство» карточки заказа (`/admin/orders/[id]?tab=production`).
 *
 * Данные — `getProductionDocumentForOrder(orderId)`
 * (`apps/web/lib/production-documents-api.ts` →
 * `GET /api/admin/orders/:id/production-document`). Запрос делает САМА
 * вкладка и передаёт результат пропсом: блок сознательно синхронный, иначе
 * его fetch стартовал бы только после всей цепочки `await` вкладки.
 *
 * Доменное правило, которое держит этот блок:
 *   документ выпуска НЕ проводят и НЕ подтверждают. Он рождается закрытием
 *   заказа и собирается сам из фактов производства. Состояния два, оба
 *   наступают без человека: `FORMING` (факты ещё идут — причины в
 *   `pendingReasons`) и `READY` (лёг последний факт, себестоимость
 *   зафиксирована снимком).
 *
 * ⛔ ЕДИНСТВЕННОЕ исключение — кнопка «Сформировать документ», и она видна
 *   ровно в одном случае: заказ УЖЕ ЗАКРЫТ, а документа нет (`canBackfill`).
 *   Так бывает только у заказов, закрытых до появления раздела — рождаться
 *   тогда было нечему. Все входы документа исторические, поэтому выпуск
 *   восстанавливается, а не выдумывается; достроенный документ помечен
 *   `backfilledAt` и говорит об этом человеку. Никаких «провести»,
 *   «пересчитать», «согласовать» здесь нет и быть не должно.
 *
 * Ещё два правила видно прямо в разметке:
 *   - `cost.pieceworkPendingRub` в `totalRub` НЕ входит: незакрытая коробка —
 *     обещание, а не трата. Показываем отдельной строкой предупреждающим
 *     тоном с явной оговоркой «в сумму не входит», чтобы это число никто не
 *     сложил с итогом;
 *   - `recalculatedAt` ≠ null означает, что факт пришёл ПОСЛЕ фиксации и
 *     документ пересобрался. Без этой пометки расхождение с ранее увиденной
 *     суммой читается как баг.
 *
 * Себестоимость показываем компонентами (свой материал / материал ЕРП /
 * сдельная / подкрой / оклад / прочее): что из них считать себестоимостью
 * заказа, владелец решает на живых числах, поэтому одно «итого» здесь
 * недостаточно. Коды `cost.warnings` в интерфейс сознательно не пускаем —
 * человекочитаемых лейблов для них в контракте нет, их место в карточке
 * документа.
 */
import Link from 'next/link';
import { ArrowRight, PackageCheck } from 'lucide-react';
import {
  PRODUCTION_DOCUMENT_FACT_KIND_LABELS,
  PRODUCTION_DOCUMENT_STATUS_LABELS,
  type ProductionDocumentDto,
} from '@sewing/shared/production-documents';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { BuildProductionDocumentButton } from './build-production-document-button.client';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';

interface Props {
  /**
   * Документ заказа. `null` — заказ ещё не закрыт: документ рождается
   * закрытием, показывать до него нечего (это норма, а не ошибка).
   */
  doc: ProductionDocumentDto | null;
  /** Заказ. Нужен и для кнопки достройки, и для ссылок. */
  orderId: string;
  /**
   * Заказ уже ЗАКРЫТ, а документа нет — значит его закрыли до появления раздела и выпуск можно
   * достроить кнопкой. У живого потока это никогда не true: там документ рождается закрытием.
   */
  canBackfill: boolean;
  /**
   * Текст ошибки загрузки. Вкладка ловит её в свой try/catch и кладёт сюда:
   * упавший документ не должен ронять весь производственный срез заказа.
   */
  error?: string | null;
  /**
   * ADMIN / SHOP_MANAGER. Блок роль сам не вычисляет — получает готовый флаг,
   * как соседние блоки вкладки. Гейтит ТОЛЬКО переход в реестр документов:
   * сами факты выпуска видит всякий, кто уже открыл карточку заказа.
   */
  canManage: boolean;
}

/**
 * `FORMING` — не тревога, а нормальный ход дела: факты ещё идут, никто
 * ничего не должен нажимать. Поэтому `info`, а не `warning`.
 */
const STATUS_TONE: Record<ProductionDocumentDto['status'], AdminStatusTone> = {
  FORMING: 'info',
  READY: 'success',
};

/** Деньги — только рубли: документ выпуска считается в валюте цеха. */
function formatRub(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

/**
 * Дата — всегда в `Europe/Moscow`: сервер рендерит RSC в UTC, браузер
 * дорисовывает в локальной зоне, и без явного timeZone получаем hydration-
 * расхождение (см. `feedback_hydration_timezone`).
 */
function formatMoment(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Компоненты себестоимости в порядке «материал → труд → прочее». Нулевые
 * составляющие не печатаем: в блоке заказа важен состав траты, а не полный
 * список полей DTO (он есть в карточке документа).
 */
function costParts(
  cost: ProductionDocumentDto['cost'],
): { label: string; rub: number }[] {
  return [
    { label: 'свой материал', rub: cost.materialsOwnRub },
    { label: 'материал ЕРП', rub: cost.materialsErpRub },
    { label: 'сдельная', rub: cost.pieceworkRub },
    { label: 'подкрой', rub: cost.recutRub },
    { label: 'оклад', rub: cost.salaryRub },
    { label: 'прочее', rub: cost.otherRub },
  ].filter((p) => Number.isFinite(p.rub) && p.rub !== 0);
}

export function OrderProductionDocumentSection({
  doc,
  error,
  canManage,
  orderId,
  canBackfill,
}: Props) {
  const parts = doc ? costParts(doc.cost) : [];
  // Первая причина — та, которую ждут прямо сейчас; остальные перечислять в
  // карточке заказа незачем, полный список живёт в самом документе.
  const pending = doc?.pendingReasons[0] ?? null;

  return (
    <AdminCard className="admin-order-detail-card-compact">
      <AdminSectionHeader
        icon={<PackageCheck size={18} strokeWidth={1.7} aria-hidden />}
        title="Документ выпуска"
        hint="собирается сам из фактов цеха"
        actions={
          doc ? (
            <AdminStatusBadge tone={STATUS_TONE[doc.status]}>
              {PRODUCTION_DOCUMENT_STATUS_LABELS[doc.status]}
            </AdminStatusBadge>
          ) : undefined
        }
      />

      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : !doc ? (
        <AdminEmptyState
          icon={<PackageCheck size={26} strokeWidth={1.6} aria-hidden />}
          title={
            canBackfill
              ? 'Заказ закрыт до появления раздела'
              : 'Документ появится, когда заказ закроется'
          }
          hint={
            canBackfill
              ? 'Выпуск можно достроить: состав соберётся из упакованных паспортов, себестоимость — из списаний, начислений и подкроя по этому заказу. Номер получит дату закрытия заказа.'
              : 'Заводить его руками не нужно: документ собирается сам из фактов производства — упаковки, начислений, закрытия заказа.'
          }
          actions={
            canBackfill && canManage ? (
              <BuildProductionDocumentButton orderId={orderId} />
            ) : undefined
          }
        />
      ) : (
        <>
          {doc.backfilledAt ? (
            <p className="admin-note">
              Документ достроен по уже закрытому заказу — номер от даты закрытия, строка заведена
              позже. Состав и себестоимость восстановлены по фактам производства.
            </p>
          ) : null}
          <dl className="admin-deflist">
            <dt>Номер</dt>
            <dd>
              {canManage ? (
                <Link href={`/admin/production-documents/${doc.id}`}>
                  <strong>{doc.number}</strong>
                </Link>
              ) : (
                <strong>{doc.number}</strong>
              )}
            </dd>

            <dt>Годных</dt>
            <dd>
              {doc.qtyGood.toLocaleString('ru-RU')} из{' '}
              {doc.qtyPlan.toLocaleString('ru-RU')} шт
              {doc.qtyDefect > 0 && (
                <>
                  {' '}
                  <span className="admin-muted">
                    · брак {doc.qtyDefect.toLocaleString('ru-RU')} шт
                  </span>
                </>
              )}
            </dd>

            <dt>Себестоимость</dt>
            <dd>
              <strong>{formatRub(doc.cost.totalRub)}</strong>{' '}
              <span className="admin-muted">
                · {formatRub(doc.cost.perUnitRub)} за штуку
              </span>
              {parts.length > 0 && (
                <div
                  className="admin-muted"
                  style={{ marginTop: 2, fontSize: '0.82rem' }}
                >
                  {parts
                    .map((p) => `${p.label} ${formatRub(p.rub)}`)
                    .join(' · ')}
                </div>
              )}
            </dd>

            {doc.status === 'READY' ? (
              <>
                <dt>Окончателен с</dt>
                <dd>
                  {formatMoment(doc.readyAt ?? doc.lastFactAt)}
                  {doc.lastFactKind && (
                    <>
                      {' '}
                      <span className="admin-muted">
                        · {PRODUCTION_DOCUMENT_FACT_KIND_LABELS[doc.lastFactKind]}
                      </span>
                    </>
                  )}
                </dd>
              </>
            ) : (
              <>
                <dt>Ещё формируется</dt>
                <dd>
                  {pending ? (
                    <>
                      {pending.text}
                      {pending.detail && (
                        <>
                          {' '}
                          <span className="admin-muted">
                            · {pending.detail}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="admin-muted">
                      ждём последний факт производства
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>

          {/*
            Сдельная в ожидании — не трата, а обещание: коробка ещё открыта,
            начисления не подтверждены. В `totalRub` она не входит, и об этом
            надо сказать словами, иначе менеджер сложит два числа руками.
          */}
          {doc.cost.pieceworkPendingRub > 0 && (
            <p
              className="admin-muted"
              style={{
                marginTop: '0.5rem',
                marginBottom: 0,
                fontSize: '0.85rem',
                padding: '0.4rem 0.6rem',
                background: '#fef3c7',
                color: '#92400e',
                borderRadius: 4,
              }}
            >
              Сдельная в ожидании: {formatRub(doc.cost.pieceworkPendingRub)} — в
              сумму не входит, пока начисления не подтверждены.
            </p>
          )}

          {/*
            Пересборка после фиксации: сумма могла измениться уже после того,
            как её увидели. Показываем и когда, и почему.
          */}
          {doc.recalculatedAt && (
            <p
              className="admin-muted"
              style={{ marginTop: '0.5rem', marginBottom: 0, fontSize: '0.85rem' }}
            >
              Пересобран {formatMoment(doc.recalculatedAt)}
              {doc.recalcReason ? `: ${doc.recalcReason}` : ''} — факт пришёл
              после фиксации.
            </p>
          )}

          {canManage && (
            <div style={{ marginTop: '0.6rem' }}>
              <Link
                href={`/admin/production-documents/${doc.id}`}
                className="admin-table__action-link"
              >
                Открыть документ
                <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
              </Link>
            </div>
          )}
        </>
      )}
    </AdminCard>
  );
}
