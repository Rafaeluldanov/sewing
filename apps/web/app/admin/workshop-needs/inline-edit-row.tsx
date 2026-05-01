'use client';

/**
 * Inline-редактирование строки потребности.
 *
 * Этап «Себестоимость заказа» (см.
 * `docs/recon-soft-integration.md §«Себестоимость заказа»`).
 *
 * Закупщик правит «К закупке», цену, валюту, поставщика, дату прямо
 * в строке списка `/admin/workshop-needs?view=lines` и в группе
 * заказа `/admin/workshop-needs?view=orders` — без перехода на
 * отдельную карточку. Используется тот же server-action
 * `updateWorkshopNeedAction`, что и в полной форме редактирования
 * `/admin/workshop-needs/[id]`.
 *
 * Polish-итерация «Компактное inline-редактирование»:
 *   - layout перешёл с двумерного `admin-form-grid` (большая
 *     вертикальная форма) на горизонтальный CSS-grid
 *     `.workshop-need-line` — на desktop одна потребность ≈ одна
 *     строка. На узких экранах сетка сворачивается в карточку
 *     (см. globals.css `.workshop-need-line` в @media).
 *   - используется в двух местах:
 *       • `view=lines` — строка списка (showOrderInfo = true);
 *         доступен bulk-PO чекбокс.
 *       • `view=orders` — внутри `OrderNeedGroupCard`
 *         (showOrderInfo = false, превью/клиент уже в header
 *         группы), без bulk-PO.
 *   - label у поля цены — «Цена за 1 <unit>» (без введения
 *     отдельного `total`-поля; line total считается в UI как
 *     `finalQty × quotedPrice`).
 *   - select валюты ограничен `MONEY_CURRENCIES` (RUB / USD).
 *
 * SaaS-итерация «Карточка заказа в view=orders»:
 *   - в режиме `showOrderInfo=false` строка переключается на
 *     дополнительный grid `.workshop-order-need-row`
 *     (10-колоночный, target row-height ≈ 64px). Превью / номер
 *     заказа / клиент / тип не рендерятся — они уже в header
 *     карточки заказа.
 *   - комментарий закупщика скрыт по умолчанию: в строке
 *     показывается только маленькая кнопка «Комментарий» с
 *     индикатором, когда коммент уже сохранён. По клику textarea
 *     раскрывается полнострочно. В режиме `view=lines` поведение
 *     то же — comment-toggle единый, чтобы grouped/lines выглядели
 *     одинаково и закупщик не путался.
 *   - bulk-чекбокс остался привязан к `bulkSelect` и работает
 *     только в `view=lines` (см. `page.tsx`).
 */

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import {
  ImageOff,
  Save,
  XCircle,
  CheckCircle2,
  MessageSquare,
  ChevronUp,
} from 'lucide-react';
import {
  MONEY_CURRENCIES,
  MONEY_CURRENCY_LABELS,
} from '@sewing/shared/money';
import {
  WORKSHOP_NEED_STATUSES,
  WORKSHOP_NEED_STATUS_LABELS,
  getWorkshopNeedKind,
  WORKSHOP_NEED_KIND_LABELS,
  type WorkshopNeedListItemDto,
  type WorkshopNeedStatus,
  type WorkshopNeedKind,
} from '@sewing/shared/workshop-needs';
import { AdminStatusBadge } from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { BulkCreatePoCheckbox } from './bulk-create-po';
import { updateWorkshopNeedAction } from './actions';
import { initialUpdateWorkshopNeedState } from './form-state';

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Подпись поля цены: «Цена за 1 <unit>». Валюта живёт в соседнем
 * select-е, поэтому символ ₽/$ не дублируем здесь.
 */
function formatPriceLabel(unit: string | null | undefined): string {
  const u = (unit ?? '').trim();
  if (u === '') return 'Цена за 1';
  return `Цена за 1 ${u}`;
}

/**
 * Сжимает «1.5000» → «1.5», «9600.00» → «9600», «9600» оставляет.
 * Используется только для preview (`finalQty`/`lineTotal`); БД
 * хранит Decimal как пришёл.
 */
function trimDecimal(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function parseDecimalString(s: string | null): number | null {
  if (s === null) return null;
  const raw = s.trim().replace(',', '.');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatLineTotalNumber(n: number): string {
  return n.toLocaleString('ru-RU', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

function currencySymbol(c: string | null | undefined): string {
  switch ((c ?? '').toUpperCase()) {
    case 'RUB':
      return '₽';
    case 'USD':
      return '$';
    default:
      return '';
  }
}

const KIND_TONE: Record<WorkshopNeedKind, string> = {
  MATERIAL: 'workshop-need-kind-badge--material',
  HARDWARE: 'workshop-need-kind-badge--hardware',
  APPLICATION: 'workshop-need-kind-badge--application',
  OTHER: 'workshop-need-kind-badge--other',
};

function statusTone(status: string): AdminStatusTone {
  switch (status as WorkshopNeedStatus) {
    case 'CALCULATED':
      return 'info';
    case 'REVIEWED':
      return 'muted';
    case 'PURCHASE_PLANNED':
      return 'success';
    case 'ORDERED':
      return 'success';
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'RECEIVED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function NomenclaturePreview({
  src,
  alt,
}: {
  src: string | null;
  alt: string;
}) {
  if (!src) {
    return (
      <span
        className="workshop-order-preview workshop-order-preview--sm workshop-order-preview--empty"
        aria-label={alt}
      >
        <ImageOff size={14} strokeWidth={1.4} aria-hidden />
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      className="workshop-order-preview workshop-order-preview--sm"
      src={src}
      alt={alt}
    />
  );
}

function SubmitButton({ compact }: { compact: boolean }) {
  const { pending } = useFormStatus();
  if (compact) {
    return (
      <button
        type="submit"
        className="admin-btn admin-btn--primary workshop-order-need-row__save"
        disabled={pending}
        title="Сохранить изменения"
        aria-label="Сохранить"
      >
        {pending ? (
          <span className="workshop-order-need-row__save-text">…</span>
        ) : (
          <CheckCircle2 size={16} strokeWidth={1.8} aria-hidden />
        )}
      </button>
    );
  }
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary workshop-need-inline__save"
      disabled={pending}
      title="Сохранить изменения"
    >
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? '…' : 'Сохранить'}
    </button>
  );
}

export interface InlineEditWorkshopNeedRowProps {
  need: WorkshopNeedListItemDto;
  /**
   * Показывать ли «шапку» строки (превью + номер заказа +
   * клиент + бейдж типа). В режиме `view=lines` это `true` — это
   * и есть «строка списка». В режиме `view=orders` это `false` —
   * превью/клиент уже в header группы заказа.
   */
  showOrderInfo?: boolean;
  /**
   * Показывать ли чекбокс bulk-PO. Включён только в `view=lines`
   * при включённом feature-flag `purchase-orders`. Внутри
   * `view=orders` обычно отключено.
   */
  bulkSelect?: boolean;
}

export function InlineEditWorkshopNeedRow({
  need,
  showOrderInfo = false,
  bulkSelect = false,
}: InlineEditWorkshopNeedRowProps) {
  const [state, action] = useFormState(
    updateWorkshopNeedAction.bind(null, need.id),
    initialUpdateWorkshopNeedState,
  );

  const initialCurrency = (need.quotedCurrency ?? '').toUpperCase();
  const validInitialCurrency = MONEY_CURRENCIES.includes(
    initialCurrency as (typeof MONEY_CURRENCIES)[number],
  )
    ? initialCurrency
    : '';

  // Controlled-state — нужен ТОЛЬКО для preview «Сумма строки»
  // (`finalQty × unit price`). Любая другая возможность была бы
  // некорректна: backend получает ровно те же значения, что
  // оказались в input/select на момент submit-а.
  const [purchaseQtyValue, setPurchaseQtyValue] = useState<string>(
    need.purchaseQty ?? '',
  );
  const [quotedPriceValue, setQuotedPriceValue] = useState<string>(
    need.quotedPrice ?? '',
  );
  const [currency, setCurrency] = useState<string>(validInitialCurrency);

  const hasComment = (need.comment ?? '').trim().length > 0;
  // Комментарий закупщика по умолчанию скрыт. Кнопка-toggle
  // показывает текущее значение (если есть) и раскрывает textarea
  // для редактирования. SaaS-итерация: одинаково в lines/orders.
  const [commentOpen, setCommentOpen] = useState<boolean>(false);

  const isCancelled = need.status === 'CANCELLED';
  const isLockedByPo =
    need.status === 'ORDERED' ||
    need.status === 'PARTIALLY_RECEIVED' ||
    need.status === 'RECEIVED';

  // Этап «Исправить формирование Потребности цеха» (см. ТЗ §7
  // «Исправить классификацию секций»): теперь kind считается по
  // materialRole — это убирает нитки / синтепон / дублерин из
  // секции «Фурнитура» (раньше попадали туда из-за
  // sourceType=PATTERN_PARAMETER_NORM или calculationMethod=QTY_PER_UNIT).
  const kind = getWorkshopNeedKind({
    sourceType: need.sourceType,
    calculationMethod: need.calculationMethod,
    materialRole: need.materialRole,
  });

  const orderHref = `/admin/orders/${encodeURIComponent(need.orderId)}`;
  const detailHref = `/admin/workshop-needs/${encodeURIComponent(need.id)}`;

  const priceLabel = formatPriceLabel(need.unit);

  // Line total preview: finalQty × unit price.
  const purchaseQtyNum = parseDecimalString(purchaseQtyValue);
  const baseQtyNum =
    purchaseQtyNum ?? parseDecimalString(need.calculatedQty);
  const priceNum = parseDecimalString(quotedPriceValue);
  const lineTotal =
    priceNum !== null && baseQtyNum !== null
      ? priceNum * baseQtyNum
      : null;
  const symbol = currencySymbol(currency);

  // Базовый класс формы: в lines-mode — старый grid с превью/клиентом,
  // в orders-mode — компактный 10-колоночный SaaS-grid.
  const rootClassName = showOrderInfo
    ? 'workshop-need-line workshop-need-inline-form workshop-need-line--with-order'
    : 'workshop-order-need-row workshop-need-inline-form';

  return (
    <form
      action={action}
      className={rootClassName}
      data-need-id={need.id}
      data-variant={showOrderInfo ? 'lines' : 'orders'}
    >
      {/* === checkbox bulk-PO (только в view=lines) === */}
      {bulkSelect && (
        <div
          className="workshop-need-line__cell workshop-need-line__cell--check"
          data-cell="check"
        >
          <BulkCreatePoCheckbox need={need} />
        </div>
      )}

      {/* === Order info (только в view=lines): preview + № + клиент === */}
      {showOrderInfo && (
        <div
          className="workshop-need-line__cell workshop-need-line__cell--order"
          data-cell="order"
        >
          <NomenclaturePreview
            src={need.nomenclaturePreviewImageUrl}
            alt={need.nomenclatureName ?? need.orderNumber ?? 'Заказ'}
          />
          <div className="workshop-need-line__order-text">
            {need.orderNumber ? (
              <Link
                href={orderHref}
                className="admin-table__action-link workshop-need-line__order-number"
              >
                <strong>{need.orderNumber}</strong>
              </Link>
            ) : (
              <span className="admin-muted">—</span>
            )}
            {need.clientName && (
              <span className="workshop-need-line__client admin-muted">
                {need.clientName}
              </span>
            )}
          </div>
        </div>
      )}

      {/* === Type badge (только в view=lines) === */}
      {showOrderInfo && (
        <div
          className="workshop-need-line__cell workshop-need-line__cell--kind"
          data-cell="kind"
        >
          <span className={`workshop-need-kind-badge ${KIND_TONE[kind]}`}>
            {WORKSHOP_NEED_KIND_LABELS[kind]}
          </span>
        </div>
      )}

      {/* === Description === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--description'
            : 'workshop-order-need-row__cell workshop-order-need-row__description'
        }
        data-cell="description"
      >
        <div className="workshop-need-line__description-row">
          {need.materialImageUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              className="workshop-need-line__material-image"
              src={need.materialImageUrl}
              alt={need.sourceName ?? need.description}
            />
          )}
          <span className="workshop-need-line__description-text">
            {need.description}
          </span>
        </div>
        {(() => {
          // Этап «Исправить формирование Потребности цеха» (см. ТЗ §5):
          // для фурнитуры / тканей рисуем secondary-строку с
          // дополнительными характеристиками: размер фурнитуры,
          // материал, цвет (если резолвен или снят с заказа).
          // UI specs: «Молния → 60 см · пластик · цвет бордо».
          const secondaryParts: string[] = [];
          if (need.hardwareSizeText) {
            secondaryParts.push(need.hardwareSizeText);
          }
          if (need.hardwareMaterialText) {
            secondaryParts.push(need.hardwareMaterialText);
          }
          if (need.selectedColorText) {
            secondaryParts.push(`цвет ${need.selectedColorText}`);
          }
          if (secondaryParts.length === 0) return null;
          return (
            <span className="admin-muted workshop-need-line__hardware-meta">
              {secondaryParts.join(' · ')}
            </span>
          );
        })()}
        {need.calculationNote && (
          <span
            className="admin-muted workshop-need-line__note"
            title={need.calculationNote}
          >
            {need.calculationNote}
          </span>
        )}
        {need.requiresColorSelection && !need.selectedColorText && (
          <span
            className="workshop-need-line__color-warning"
            role="status"
            title="Цвет нужно указать в заказе"
          >
            Цвет нужно указать в заказе
          </span>
        )}
      </div>

      {/* === calculatedQty + unit === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--calc'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--calc'
        }
        data-cell="calc"
      >
        <span className="workshop-need-line__hint">Нужно</span>
        <strong className="workshop-need-line__qty-value">
          {trimDecimal(need.calculatedQty)}
          {need.unit ? ` ${need.unit}` : ''}
        </strong>
      </div>

      {/* === purchaseQty input === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--purchase'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--purchase workshop-order-need-row__field'
        }
        data-cell="purchase"
      >
        <label
          htmlFor={`wnq-${need.id}`}
          className="workshop-need-line__hint"
        >
          К закупке
        </label>
        <input
          id={`wnq-${need.id}`}
          name="purchaseQty"
          type="text"
          inputMode="decimal"
          value={purchaseQtyValue}
          onChange={(e) => setPurchaseQtyValue(e.target.value)}
          placeholder={trimDecimal(need.calculatedQty)}
          disabled={isCancelled || isLockedByPo}
        />
      </div>

      {/* === quotedPrice input (label = «Цена за 1 <unit>») === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--price'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--price workshop-order-need-row__field'
        }
        data-cell="price"
      >
        <label
          htmlFor={`wnp-${need.id}`}
          className="workshop-need-line__hint"
        >
          {priceLabel}
        </label>
        <input
          id={`wnp-${need.id}`}
          name="quotedPrice"
          type="text"
          inputMode="decimal"
          value={quotedPriceValue}
          onChange={(e) => setQuotedPriceValue(e.target.value)}
          placeholder="0.00"
          disabled={isCancelled}
          aria-describedby={`wnp-hint-${need.id}`}
        />
      </div>

      {/* === currency select === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--currency'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--currency workshop-order-need-row__field'
        }
        data-cell="currency"
      >
        <label
          htmlFor={`wnc-${need.id}`}
          className="workshop-need-line__hint"
        >
          Валюта
        </label>
        <select
          id={`wnc-${need.id}`}
          name="quotedCurrency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          disabled={isCancelled}
        >
          <option value="">— не выбрана —</option>
          {MONEY_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {MONEY_CURRENCY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      {/* === computed line total: finalQty × unit price === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--total'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--total'
        }
        data-cell="total"
      >
        <span className="workshop-need-line__hint">Сумма</span>
        {lineTotal !== null ? (
          <span
            className="workshop-need-line__total"
            id={`wnp-hint-${need.id}`}
            aria-live="polite"
          >
            <strong>{formatLineTotalNumber(lineTotal)}</strong>
            {symbol && (
              <span className="workshop-need-line__total-currency">
                {' '}
                {symbol}
              </span>
            )}
          </span>
        ) : (
          <span
            className="admin-muted"
            id={`wnp-hint-${need.id}`}
            aria-live="polite"
          >
            —
          </span>
        )}
      </div>

      {/* === Supplier (text fallback) === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--supplier'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--supplier workshop-order-need-row__field'
        }
        data-cell="supplier"
      >
        <label
          htmlFor={`wns-${need.id}`}
          className="workshop-need-line__hint"
        >
          Поставщик
        </label>
        <input
          id={`wns-${need.id}`}
          name="supplierNameText"
          type="text"
          maxLength={200}
          defaultValue={need.supplierNameText ?? ''}
          placeholder={
            need.selectedSupplierName
              ? `Сейчас: ${need.selectedSupplierName}`
              : '—'
          }
          disabled={isCancelled}
        />
      </div>

      {/* === expected delivery date === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--date'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--date workshop-order-need-row__field'
        }
        data-cell="date"
      >
        <label
          htmlFor={`wnd-${need.id}`}
          className="workshop-need-line__hint"
        >
          Поставка
        </label>
        <input
          id={`wnd-${need.id}`}
          name="expectedDeliveryDate"
          type="date"
          defaultValue={isoToDateInput(need.expectedDeliveryDate)}
          disabled={isCancelled}
        />
      </div>

      {/* === status === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--status'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--status workshop-order-need-row__field'
        }
        data-cell="status"
      >
        <label
          htmlFor={`wnst-${need.id}`}
          className="workshop-need-line__hint"
        >
          Статус
        </label>
        <select
          id={`wnst-${need.id}`}
          name="status"
          defaultValue={need.status}
          disabled={isCancelled || isLockedByPo}
        >
          {WORKSHOP_NEED_STATUSES.map((s) => (
            <option key={s} value={s}>
              {WORKSHOP_NEED_STATUS_LABELS[s as WorkshopNeedStatus]}
            </option>
          ))}
        </select>
        {showOrderInfo && (
          <AdminStatusBadge tone={statusTone(need.status)}>
            {WORKSHOP_NEED_STATUS_LABELS[need.status as WorkshopNeedStatus] ??
              need.status}
          </AdminStatusBadge>
        )}
      </div>

      {/* === Save button + detail link === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--save'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--save'
        }
        data-cell="save"
      >
        <SubmitButton compact={!showOrderInfo} />
        {showOrderInfo && (
          <Link
            href={detailHref}
            className="admin-table__action-link workshop-need-line__detail-link"
            title="Открыть полную карточку — связь со справочником поставщиков, история, аудит"
          >
            Подробнее
          </Link>
        )}
      </div>

      {/*
        Комментарий закупщика — collapse-блок. По умолчанию textarea
        скрыта; в строке только маленькая кнопка-toggle с
        индикатором, если коммент уже сохранён в БД. Клик
        раскрывает textarea на всю ширину строки. Имя поля
        `comment` совпадает со старой `EditWorkshopNeedForm` —
        контракт `updateWorkshopNeedAction.buildUpdateDto` не
        меняли.
      */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-order-need-row__comment-toggle workshop-order-need-row__comment-toggle--lines'
            : 'workshop-order-need-row__cell workshop-order-need-row__comment-toggle'
        }
        data-cell="comment-toggle"
      >
        <button
          type="button"
          className={`admin-btn admin-btn--ghost workshop-order-need-row__comment-button${
            commentOpen
              ? ' workshop-order-need-row__comment-button--open'
              : ''
          }${
            hasComment
              ? ' workshop-order-need-row__comment-button--has'
              : ''
          }`}
          aria-expanded={commentOpen}
          aria-controls={`wnm-${need.id}`}
          onClick={() => setCommentOpen((v) => !v)}
          title={
            hasComment
              ? `Комментарий: ${need.comment}`
              : 'Добавить комментарий'
          }
        >
          {commentOpen ? (
            <ChevronUp size={14} strokeWidth={1.6} aria-hidden />
          ) : (
            <MessageSquare size={14} strokeWidth={1.6} aria-hidden />
          )}
          <span className="workshop-order-need-row__comment-button-label">
            {commentOpen
              ? 'Скрыть'
              : hasComment
              ? 'Комментарий есть'
              : 'Комментарий'}
          </span>
          {hasComment && !commentOpen && (
            <span
              className="workshop-order-need-row__comment-dot"
              aria-hidden
            />
          )}
        </button>
      </div>

      {/*
        Скрытый комментарий: всегда отправляется на backend (имя
        поля `comment`). Если кнопка-toggle закрыта — рендерим как
        `<input type="hidden">` с текущим значением; если открыта —
        раскрываем полнострочный textarea, поле остаётся под тем
        же name. Backend нормализует пустую строку в null.
      */}
      {commentOpen ? (
        <div
          className="workshop-need-line__cell workshop-order-need-row__comment workshop-need-inline__comment"
          data-cell="comment"
        >
          <label
            htmlFor={`wnm-${need.id}`}
            className="workshop-need-line__hint"
          >
            Комментарий закупщика
          </label>
          <textarea
            id={`wnm-${need.id}`}
            name="comment"
            maxLength={1000}
            defaultValue={need.comment ?? ''}
            placeholder="—"
            disabled={isCancelled}
            rows={2}
          />
        </div>
      ) : (
        <input
          type="hidden"
          name="comment"
          value={need.comment ?? ''}
        />
      )}

      {/*
        UI-блок результатов: ошибка / success-флаг. Лежит ПОД grid-ом,
        чтобы не разрывать выравнивание полей.
      */}
      {state.error && (
        <div
          className="error-box workshop-need-inline__alert"
          role="alert"
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          <span>{state.error}</span>
        </div>
      )}
      {state.ok && state.successMessage && (
        <div
          className="success-box workshop-need-inline__alert"
          role="status"
        >
          <CheckCircle2 size={14} strokeWidth={1.6} aria-hidden />
          <span>{state.successMessage}</span>
        </div>
      )}
    </form>
  );
}

export default InlineEditWorkshopNeedRow;
