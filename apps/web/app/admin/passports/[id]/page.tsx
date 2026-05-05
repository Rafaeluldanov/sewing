/**
 * Управленческая карточка паспорта `/admin/passports/[id]`
 * (Admin UI 2.6).
 *
 * Зачем отдельная страница, а не редизайн `/passports/[id]`:
 *   - Layout `/admin/*` уже скрывает глобальный `<AppHeader>` (см.
 *     `apps/web/components/app-header.tsx`, hide-rule на
 *     `pathname.startsWith('/admin/')`) и подключает левую
 *     `AdminSidebar` — менеджеру нужен именно этот chrome,
 *     а не «верхняя шапка с навигацией» legacy-страницы.
 *   - У `/admin/*` уже стоит RBAC-guard в `app/admin/layout.tsx`
 *     (`canSeeAdmin`), поэтому здесь не нужно дублировать проверку.
 *   - Производственным ролям (CUTTER / SEAMSTRESS / …) admin-сайдбар
 *     не нужен — у них останется legacy `/passports/[id]` (см. ниже).
 *
 * Что показываем:
 *   - Шапка `AdminPageShell` (иконка Package, title «Паспорт № …»,
 *     подзаголовок «Заказ N», actions: «К заказу», PrintButton,
 *     «Удалить паспорт»).
 *   - `AdminCard` секции: Сведения / QR / Закрытие раскроя
 *     (опционально) / ОТК / Упаковка / Начисления / Размещение.
 *
 * Бизнес-логика и API:
 *   - DTO/`getPassport` / списки defects / earnings / cutting-closure —
 *     те же, что на legacy-странице;
 *   - server-actions `placePassportAction` /
 *     `deletePassportFromDetailAction` /
 *     `request|approve|rejectCuttingClosureAction` уже ревалидируют
 *     `/passports/:id` и `/orders/:id` — мы дополнительно ревалидируем
 *     `/admin/passports/:id` и `/admin/orders/:id` отдельным
 *     обновлением actions (см. там же).
 *
 * RBAC:
 *   - layout `/admin/*` пускает `ADMIN` / `SHOP_MANAGER`;
 *   - DELETE / cutting-closure approve/reject backend защищает сам.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardCheck,
  Package,
  PackageOpen,
  Printer,
  Scissors,
  Warehouse,
  Wallet,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getPassport, listCells } from '@/lib/passports-api';
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
import { getPassportCuttingClosureRequest } from '@/lib/cutting-closure-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import { statusTone } from '@/lib/admin-labels';
import { PASSPORT_STATUS_LABELS } from '@/lib/passport-status-labels';
import { PrintButton } from '@/components/print-button';
import { PlaceForm } from '@/app/passports/[id]/place-form';
import { CuttingClosureSection } from '@/app/passports/[id]/cutting-closure-section';
import { DeleteFromDetailButton } from '@/app/passports/[id]/delete-from-detail-button';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

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

function formatMoney(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isEarningsManager(role: string | undefined): boolean {
  return role === 'SHOP_MANAGER' || role === 'ADMIN';
}

interface FieldRowProps {
  label: string;
  children: React.ReactNode;
}

function FieldRow({ label, children }: FieldRowProps) {
  return (
    <div className="admin-passport-field">
      <span className="admin-passport-field__label">{label}</span>
      <span className="admin-passport-field__value">{children}</span>
    </div>
  );
}

export default async function AdminPassportDetailPage({ params }: Params) {
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
  const role = me?.user.role;
  const isManager = isEarningsManager(role);
  const earnings = await listPassportEarnings(passport.id);

  // ADR-0018: блок «Закрытие раскроя по размеру». Помощник раскройщика
  // на admin-странице по факту не появляется (layout `/admin/*` его не
  // пускает), поэтому здесь блок видят менеджеры — для одобрения /
  // отклонения уже поданной заявки. Формы «подать заявку» при
  // role !== CUTTER_ASSISTANT не рендерятся — `canRequest = false`.
  const canRequestClosure = role === 'CUTTER_ASSISTANT';
  const canReviewClosure = role === 'SHOP_MANAGER' || role === 'ADMIN';
  const showClosureSection = canRequestClosure || canReviewClosure;
  const canDeletePassport = role === 'SHOP_MANAGER' || role === 'ADMIN';
  const closureRequest = showClosureSection
    ? await getPassportCuttingClosureRequest(passport.id)
    : null;

  const totalApproved = earnings
    .filter((e) => e.status === 'APPROVED')
    .reduce((s, e) => s + e.amount, 0);
  const totalPending = earnings
    .filter((e) => e.status === 'PENDING_RELEASE')
    .reduce((s, e) => s + e.amount, 0);

  // Печатные формы и QR живут на API — относительные пути.
  // `/api/...` идёт через nginx-proxy, см. legacy-страницу.
  const printHref = buildPassportPrintPath(passport.id);
  const qrHref = buildPassportQrPath(passport.id);

  return (
    <AdminPageShell
      icon={<Package size={22} strokeWidth={1.6} aria-hidden />}
      title={`Паспорт № ${passport.number}`}
      subtitle={
        <>
          Заказ{' '}
          <Link
            href={`/admin/orders/${passport.orderId}?tab=passports`}
            className="admin-link"
          >
            {passport.orderNumber}
          </Link>{' '}
          · Создан {formatDateTime(passport.createdAt)}
        </>
      }
      actions={
        <>
          <Link
            href={`/admin/orders/${passport.orderId}?tab=passports`}
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К заказу
          </Link>
          <AdminStatusBadge tone={statusTone(passport.status)}>
            {PASSPORT_STATUS_LABELS[passport.status]}
          </AdminStatusBadge>
          <PrintButton
            sourceType="PASSPORT_PRINT"
            sourceId={passport.id}
            fallbackHref={printHref}
            className="admin-btn admin-btn--primary"
            label="Печать"
            iconName="output"
          />
          {canDeletePassport && (
            <DeleteFromDetailButton
              passportId={passport.id}
              orderId={passport.orderId}
              passportNumber={passport.number}
            />
          )}
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader
              icon={<Package size={18} strokeWidth={1.7} aria-hidden />}
              title="Сведения"
            />
            <div className="admin-passport-fields">
              <FieldRow label="Изделие">{passport.productName}</FieldRow>
              <FieldRow label="Цвет">{passport.color || '—'}</FieldRow>
              <FieldRow label="Размер">
                <strong>{passport.sizeCode}</strong>
              </FieldRow>
              <FieldRow label="Количество">
                <strong>{passport.qtyCut}</strong> шт
              </FieldRow>
              <FieldRow label="Рулон">{passport.rollNumber || '—'}</FieldRow>
              <FieldRow label="Дата кроя">
                {formatDate(passport.cutDate)}
              </FieldRow>
              <FieldRow label="Раскройщик">
                {passport.cutterName || '—'}
              </FieldRow>
              <FieldRow label="Создал">{passport.creatorName || '—'}</FieldRow>
              <FieldRow label="Ячейка">
                {passport.currentCell ? (
                  <AdminStatusBadge tone="info">
                    {passport.currentCell.code}
                  </AdminStatusBadge>
                ) : (
                  <span className="admin-muted">— не размещён —</span>
                )}
              </FieldRow>
            </div>
          </AdminCard>

          {showClosureSection && (
            <AdminCard>
              <AdminSectionHeader
                icon={<Scissors size={18} strokeWidth={1.7} aria-hidden />}
                title="Закрытие раскроя"
                hint={
                  canRequestClosure && !closureRequest
                    ? 'Подайте заявку, если по этому размеру дальше кроить не будут.'
                    : undefined
                }
              />
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
                        qtyRemaining: Math.max(
                          passport.qtyPlan - passport.qtyCut,
                          0,
                        ),
                      }
                }
              />
            </AdminCard>
          )}

          <AdminCard>
            <AdminSectionHeader
              icon={<Wallet size={18} strokeWidth={1.7} aria-hidden />}
              title={isManager ? 'Начисления' : 'Мои начисления по паспорту'}
              hint={
                earnings.length > 0
                  ? `Подтверждено ${formatMoney(totalApproved)} ₽${
                      isManager
                        ? ` · Ожидает ${formatMoney(totalPending)} ₽`
                        : ''
                    }`
                  : undefined
              }
            />
            {earnings.length === 0 ? (
              <AdminEmptyState
                icon={<Wallet size={26} strokeWidth={1.6} aria-hidden />}
                title="Начислений нет"
                hint={
                  isManager
                    ? 'Появятся при выпуске (раскройщику) и при сканировании на следующих операциях (швее).'
                    : 'По этому паспорту у вас пока нет подтверждённых начислений.'
                }
              />
            ) : (
              <div className="admin-passport-earnings">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      {isManager && <th>Сотрудник</th>}
                      <th>Операция</th>
                      <th style={{ textAlign: 'right' }}>Кол-во</th>
                      <th style={{ textAlign: 'right' }}>Ставка</th>
                      <th style={{ textAlign: 'right' }}>Сумма</th>
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
                          <div
                            className="admin-muted"
                            style={{ fontSize: '0.85rem' }}
                          >
                            <code>{e.operationCode}</code>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>{e.qty}</td>
                        <td style={{ textAlign: 'right' }}>
                          {formatMoney(e.ratePerUnit)} ₽
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <strong>{formatMoney(e.amount)} ₽</strong>
                        </td>
                        {isManager && (
                          <td>
                            <AdminStatusBadge tone={statusTone(e.status)}>
                              {EARNING_STATUS_LABELS[e.status]}
                            </AdminStatusBadge>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader
              icon={<Printer size={18} strokeWidth={1.7} aria-hidden />}
              title="QR-этикетка"
            />
            <div className="admin-passport-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrHref} alt={`QR ${passport.number}`} />
              <code className="admin-passport-qr__code">{passport.qrCode}</code>
            </div>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              icon={<ClipboardCheck size={18} strokeWidth={1.7} aria-hidden />}
              title="ОТК"
              actions={
                passport.status === 'IN_PROGRESS' ? (
                  <Link
                    href={`/qc/passports/${passport.id}`}
                    className="admin-btn admin-btn--primary"
                  >
                    <ClipboardCheck
                      size={16}
                      strokeWidth={1.7}
                      aria-hidden
                    />
                    Открыть в ОТК
                  </Link>
                ) : null
              }
            />
            <div className="admin-passport-qc">
              <div className="admin-passport-qc__cell">
                <span className="admin-muted">Раскроено</span>
                <strong>{passport.qtyCut}</strong>
              </div>
              <div className="admin-passport-qc__cell admin-passport-qc__cell--bad">
                <span className="admin-muted">Брак</span>
                <strong>{passport.qtyDefect}</strong>
              </div>
              <div className="admin-passport-qc__cell admin-passport-qc__cell--good">
                <span className="admin-muted">Годных</span>
                <strong>{passport.qtyGood}</strong>
              </div>
            </div>
            {defects.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <div
                  className="admin-muted"
                  style={{ marginBottom: '0.4rem' }}
                >
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
                  <div
                    className="admin-muted"
                    style={{ marginTop: '0.4rem' }}
                  >
                    <Link
                      href={`/qc/passports/${passport.id}`}
                      className="admin-link"
                    >
                      Показать все ({defects.length}) в ОТК
                    </Link>
                  </div>
                )}
              </div>
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              icon={<PackageOpen size={18} strokeWidth={1.7} aria-hidden />}
              title="Упаковка"
            />
            {passport.box ? (
              <p style={{ margin: 0 }}>
                Паспорт упакован в коробку{' '}
                <Link
                  href={`/packing/boxes/${passport.box.id}`}
                  className="admin-link"
                >
                  <strong>{passport.box.number}</strong>
                </Link>
                . Статус коробки:{' '}
                <strong>
                  {passport.box.status === 'CLOSED' ? 'закрыта' : 'открыта'}
                </strong>
                .
              </p>
            ) : passport.status === 'PACKED' ? (
              <AdminEmptyState
                icon={<PackageOpen size={26} strokeWidth={1.6} aria-hidden />}
                title="Без коробки"
                hint="Паспорт помечен «Упакован», но не привязан к коробке — обратитесь к админу."
              />
            ) : (
              <AdminEmptyState
                icon={<PackageOpen size={26} strokeWidth={1.6} aria-hidden />}
                title="Ещё не упакован"
                hint={
                  passport.qtyGood > 0
                    ? `Годных штук: ${passport.qtyGood}. Сканируйте паспорт в открытую коробку через /packing.`
                    : 'Пока нет годных штук. Упаковка станет доступной после ОТК.'
                }
              />
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              icon={<Warehouse size={18} strokeWidth={1.7} aria-hidden />}
              title="Размещение в ячейке"
            />
            {passport.currentCell ? (
              <p style={{ margin: 0 }}>
                Паспорт размещён в ячейке{' '}
                <AdminStatusBadge tone="info">
                  {passport.currentCell.code}
                </AdminStatusBadge>
                . На MVP перемещение между ячейками не предусмотрено.
              </p>
            ) : passport.status !== 'CREATED' ? (
              <AdminEmptyState
                icon={<Warehouse size={26} strokeWidth={1.6} aria-hidden />}
                title="Размещение недоступно"
                hint="Размещение доступно только для паспорта в статусе «Создан»."
              />
            ) : (
              <PlaceForm
                passportId={passport.id}
                orderId={passport.orderId}
                cells={cells}
              />
            )}
          </AdminCard>

          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{passport.id}</code> },
              { label: 'QR', value: <code>{passport.qrCode}</code> },
              { label: 'Order ID', value: <code>{passport.orderId}</code> },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
