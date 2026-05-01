import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import {
  PASSPORT_STATUS_LABELS,
  getPassport,
  listCells,
} from '@/lib/passports-api';
import { listPassportDefects } from '@/lib/qc-api';
import {
  EARNING_STATUS_LABELS,
  listPassportEarnings,
} from '@/lib/earnings-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import {
  buildPassportPrintPath,
  buildPassportQrPath,
} from '@/lib/browser-api-paths';
import { AppSectionCard } from '@/components/app-section-card';
import { Icon } from '@/components/icon';
import { getPassportCuttingClosureRequest } from '@/lib/cutting-closure-api';
import { PrintButton } from '@/components/print-button';
import { PlaceForm } from './place-form';
import { CuttingClosureSection } from './cutting-closure-section';

/**
 * Роли с полной видимостью начислений (см. backend
 * `EARNINGS_MANAGER_ROLES`). Все остальные на блоке «Начисления»
 * видят только свои подтверждённые строки — backend уже фильтрует
 * `GET /api/passports/:id/earnings`, здесь только аккуратно меняем UI.
 */
function isEarningsManager(role: string | undefined): boolean {
  return role === 'SHOP_MANAGER' || role === 'ADMIN';
}

export const dynamic = 'force-dynamic';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU');
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

function formatMoneyForPassport(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <div>
      <div className="passport-field__label">{label}</div>
      <div className="passport-field__value">{children}</div>
    </div>
  );
}

export default async function PassportDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let passport;
  try {
    passport = await getPassport(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }
  const cells = await listCells();
  const defects = await listPassportDefects(passport.id);
  const me = await getCurrentUserOrNull();
  const isManager = isEarningsManager(me?.user.role);
  const earnings = await listPassportEarnings(passport.id);
  // ADR-0018: «закрытие раскроя по размеру через заявку». Подтягиваем
  // текущую заявку для строки, к которой относится паспорт. Видна она
  // помощнику раскройщика и мастеру цеха; для остальных ролей блок
  // прячем, чтобы не плодить шум.
  const role = me?.user.role;
  const canRequestClosure = role === 'CUTTER_ASSISTANT';
  const canReviewClosure = role === 'SHOP_MANAGER' || role === 'ADMIN';
  const showClosureSection = canRequestClosure || canReviewClosure;
  const closureRequest = showClosureSection
    ? await getPassportCuttingClosureRequest(passport.id)
    : null;
  const totalApproved = earnings
    .filter((e) => e.status === 'APPROVED')
    .reduce((s, e) => s + e.amount, 0);
  const totalPending = earnings
    .filter((e) => e.status === 'PENDING_RELEASE')
    .reduce((s, e) => s + e.amount, 0);

  // Печатная форма и QR живут на API. Берём **относительные** пути
  // (`/api/passports/:id/...`), чтобы ссылка/картинка открывались с
  // устройства пользователя через основной домен (nginx проксирует
  // `/api/` на backend). Использовать здесь `getClientApiUrl()` нельзя —
  // при SSR он отдаёт `INTERNAL_API_URL` (`http://127.0.0.1:3001/api`),
  // и в браузере начальника ссылка тыкается в его собственный loopback.
  const printHref = buildPassportPrintPath(passport.id);
  const qrHref = buildPassportQrPath(passport.id);

  const statusKey = passport.status.toLowerCase();

  return (
    <div className="page-shell passport-detail">
      <div className="passport-hero">
        <div className="passport-hero__qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrHref} alt={`QR ${passport.number}`} />
          <div className="passport-hero__qr-code">{passport.qrCode}</div>
        </div>
        <div className="passport-hero__info">
          <Link
            href={`/orders/${passport.orderId}`}
            className="detail-header__back"
          >
            <Icon name="arrow-right" style={{ transform: 'rotate(180deg)' }} />
            К заказу {passport.orderNumber}
          </Link>
          <div className="page-eyebrow">
            <Icon name="packing" />
            Паспорт изделия
          </div>
          <h1 className="passport-hero__title">
            <Icon name="packing" />№ {passport.number}
            <span className={`status-badge ${statusKey}`}>
              {PASSPORT_STATUS_LABELS[passport.status]}
            </span>
          </h1>
          <div className="passport-hero__sub">
            Создан {formatDateTime(passport.createdAt)} · Заказ{' '}
            <Link href={`/orders/${passport.orderId}`}>
              {passport.orderNumber}
            </Link>
          </div>
          <div className="passport-fields">
            <Field label="Изделие">{passport.productName}</Field>
            <Field label="Цвет">{passport.color}</Field>
            <Field label="Размер">{passport.sizeCode}</Field>
            <Field label="Количество">{passport.qtyCut} шт</Field>
            <Field label="Рулон">{passport.rollNumber}</Field>
            <Field label="Дата кроя">{formatDate(passport.cutDate)}</Field>
            <Field label="Раскройщик">{passport.cutterName}</Field>
            <Field label="Создал">{passport.creatorName}</Field>
            <Field label="Ячейка">
              {passport.currentCell ? (
                <span className="pill pill--accent">
                  <Icon name="warehouses" size={13} />
                  {passport.currentCell.code}
                </span>
              ) : (
                <span className="pill pill--ghost">— не размещён —</span>
              )}
            </Field>
          </div>
          <div className="actions-row" style={{ margin: 0 }}>
            <PrintButton
              sourceType="PASSPORT_PRINT"
              sourceId={passport.id}
              fallbackHref={printHref}
            />
            <Link className="btn" href={`/orders/${passport.orderId}`}>
              <Icon name="orders" size={16} />К заказу
            </Link>
          </div>
        </div>
      </div>

      {showClosureSection && (
        <AppSectionCard
          title={
            <>
              <Icon name="cutting" /> Закрытие раскроя
            </>
          }
          hint={
            canRequestClosure && !closureRequest
              ? 'Подайте заявку, если по этому размеру дальше кроить не будут. После подтверждения мастером новые паспорта по этому размеру выпускаться не будут.'
              : undefined
          }
        >
          <CuttingClosureSection
            passport={{
              id: passport.id,
              orderId: passport.orderId,
              productId: passport.productId,
              sizeId: passport.sizeId,
              sizeCode: passport.sizeCode,
              qtyCut: passport.qtyCut,
              qtyPlan: passport.qtyPlan,
            }}
            request={closureRequest}
            canRequest={canRequestClosure}
            canReview={canReviewClosure}
            fallbackPlanFact={
              closureRequest
                ? undefined
                : {
                    qtyPlan: passport.qtyPlan,
                    qtyCut: passport.qtyCut,
                    qtyRemaining: Math.max(passport.qtyPlan - passport.qtyCut, 0),
                  }
            }
          />
        </AppSectionCard>
      )}

      <AppSectionCard
        title={
          <>
            <Icon name="qc" /> Качество (ОТК)
          </>
        }
      >
        <div className="qc-summary">
          <div className="qc-summary__cell">
            <div className="qc-summary__label">Раскроено</div>
            <div className="qc-summary__value">{passport.qtyCut}</div>
          </div>
          <div className="qc-summary__cell qc-summary__cell--defect">
            <div className="qc-summary__label">Брак</div>
            <div className="qc-summary__value">{passport.qtyDefect}</div>
          </div>
          <div className="qc-summary__cell qc-summary__cell--good">
            <div className="qc-summary__label">Годных</div>
            <div className="qc-summary__value">{passport.qtyGood}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {passport.status === 'IN_PROGRESS' ? (
              <Link
                className="btn btn-primary"
                href={`/qc/passports/${passport.id}`}
              >
                <Icon name="qc" size={16} />
                Открыть в ОТК
              </Link>
            ) : (
              <span className="pill pill--ghost">
                ОТК доступен после получения кроя
              </span>
            )}
          </div>
        </div>
        {defects.length > 0 && (
          <div style={{ marginTop: '0.85rem' }}>
            <div className="meta-line" style={{ marginBottom: '0.4rem' }}>
              Зафиксировано записей брака: <strong>{defects.length}</strong>
            </div>
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {defects.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <strong>{d.defectTypeName}</strong> · {d.qty} шт.
                  {d.comment ? <> — {d.comment}</> : null}
                </li>
              ))}
            </ul>
            {defects.length > 5 && (
              <div className="meta-line" style={{ marginTop: '0.4rem' }}>
                <Link href={`/qc/passports/${passport.id}`}>
                  Показать все ({defects.length}) в ОТК
                </Link>
              </div>
            )}
          </div>
        )}
      </AppSectionCard>

      <AppSectionCard
        title={
          <>
            <Icon name="packing" /> Упаковка
          </>
        }
      >
        {passport.box ? (
          <p style={{ margin: 0 }}>
            Паспорт упакован в коробку{' '}
            <Link href={`/packing/boxes/${passport.box.id}`}>
              <strong>{passport.box.number}</strong>
            </Link>
            . Статус коробки:{' '}
            <strong>
              {passport.box.status === 'CLOSED' ? 'закрыта' : 'открыта'}
            </strong>
            . Изделие выпущено (см. ADR-0011).
          </p>
        ) : passport.status === 'PACKED' ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="warning" />
            </span>
            <span className="empty-state__title">Без коробки</span>
            <span className="empty-state__hint">
              Паспорт помечен как «Упакован», но не привязан к коробке —
              обратитесь к админу.
            </span>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="packing" />
            </span>
            <span className="empty-state__title">Ещё не упакован</span>
            <span className="empty-state__hint">
              {passport.qtyGood > 0
                ? `Годных штук: ${passport.qtyGood}. `
                : 'Пока нет годных штук. '}
              Сканируйте паспорт в открытую коробку через{' '}
              <Link href="/packing">/packing</Link>.
            </span>
          </div>
        )}
      </AppSectionCard>

      <AppSectionCard
        title={
          <>
            <Icon name="earnings" />{' '}
            {isManager ? 'Начисления' : 'Мои начисления по паспорту'}
          </>
        }
      >
        {earnings.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="earnings" />
            </span>
            <span className="empty-state__title">Начислений нет</span>
            <span className="empty-state__hint">
              {isManager ? (
                <>
                  Они появятся автоматически при выпуске (раскройщику) и при
                  сканировании на следующей операции (швее, статус «Ожидает
                  выпуск»). См. <Link href="/earnings">/earnings</Link>.
                </>
              ) : (
                <>
                  По этому паспорту у вас пока нет подтверждённых начислений.
                  Они появятся, как только ваш этап будет упакован. См.{' '}
                  <Link href="/earnings">/earnings</Link>.
                </>
              )}
            </span>
          </div>
        ) : (
          <>
            <div
              className="meta-line"
              style={{
                marginBottom: '0.6rem',
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <span className="pill pill--ok">
                <Icon name="success" size={13} />
                Подтверждено: {formatMoneyForPassport(totalApproved)} ₽
              </span>
              {isManager && (
                <>
                  <span className="pill pill--warn">
                    <Icon name="idle" size={13} />
                    Ожидает выпуск: {formatMoneyForPassport(totalPending)} ₽
                  </span>
                  <span className="pill">
                    Всего: {formatMoneyForPassport(totalApproved + totalPending)}{' '}
                    ₽
                  </span>
                </>
              )}
            </div>
            <div className="inline-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    {isManager && <th>Сотрудник</th>}
                    <th>Операция</th>
                    <th className="num">Кол-во</th>
                    <th className="num">Ставка</th>
                    <th className="num">Сумма</th>
                    {isManager && <th>Статус</th>}
                  </tr>
                </thead>
                <tbody>
                  {earnings.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDateTime(e.createdAt)}</td>
                      {isManager && <td>{e.employeeFullName}</td>}
                      <td>
                        {e.operationName}
                        <div className="meta-line">
                          <code>{e.operationCode}</code>
                        </div>
                      </td>
                      <td className="num">{e.qty}</td>
                      <td className="num">
                        {formatMoneyForPassport(e.ratePerUnit)} ₽
                      </td>
                      <td className="num">
                        <strong>{formatMoneyForPassport(e.amount)} ₽</strong>
                      </td>
                      {isManager && (
                        <td>
                          <span
                            className={`status-badge ${e.status.toLowerCase()}`}
                          >
                            {EARNING_STATUS_LABELS[e.status]}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AppSectionCard>

      <AppSectionCard
        title={
          <>
            <Icon name="warehouses" /> Размещение в ячейке
          </>
        }
      >
        {passport.currentCell ? (
          <p style={{ margin: 0 }}>
            Паспорт размещён в ячейке{' '}
            <span className="pill pill--accent">
              <Icon name="warehouses" size={13} />
              {passport.currentCell.code}
            </span>
            . На MVP перемещение между ячейками не предусмотрено.
          </p>
        ) : passport.status !== 'CREATED' ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="info" />
            </span>
            <span className="empty-state__title">Размещение недоступно</span>
            <span className="empty-state__hint">
              Размещение доступно только для паспорта в статусе «Создан».
            </span>
          </div>
        ) : (
          <PlaceForm
            passportId={passport.id}
            orderId={passport.orderId}
            cells={cells}
          />
        )}
      </AppSectionCard>
    </div>
  );
}
