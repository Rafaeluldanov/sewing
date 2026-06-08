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
import { useRef, useState } from 'react';
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
import {
  YARDS_PER_BOBBIN,
  isThreadNeed,
  metersToYards,
  yardsToMeters,
  pricePerMeterToBobbin,
  pricePerBobbinToMeter,
} from './thread-units';
import {
  isButtonNeed,
  packagesToPieces,
  piecesToPackages,
  pricePerPackToPiece,
  pricePerPieceToPack,
} from './button-units';

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

/**
 * Рендерит текст комментария, превращая URL (http/https) в
 * кликабельные ссылки. Закупщик часто оставляет ссылку на
 * поставщика / карточку товара — чтобы по ней можно было перейти,
 * а не копировать руками. Ссылки открываются в новой вкладке;
 * `stopPropagation` нужен, чтобы клик по ссылке не сворачивал
 * родительский comment-блок.
 */
function renderCommentWithLinks(text: string): React.ReactNode[] {
  const urlRe = /(https?:\/\/[^\s<>]+)/gu;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(urlRe)) {
    const url = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }
    // Завершающую пунктуацию (точка/запятая/скобка) не включаем в href.
    const trailingMatch = url.match(/[.,;:!?)\]]+$/u);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const href = trailing ? url.slice(0, url.length - trailing.length) : url;
    parts.push(
      <a
        key={`lnk-${key}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="workshop-order-need-row__comment-link"
        onClick={(e) => e.stopPropagation()}
      >
        {href}
      </a>,
    );
    if (trailing) parts.push(trailing);
    key += 1;
    lastIndex = start + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
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
        <ImageOff size={12} strokeWidth={1.4} aria-hidden />
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

export interface SupplierOption {
  id: string;
  name: string;
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
  /**
   * Включён ли модуль «Поставщики» (feature-flag). Если да — в строке
   * показывается выпадающий список поставщиков из справочника
   * (`selectedSupplierId`), а текстовое поле остаётся как fallback.
   */
  suppliersEnabled?: boolean;
  /** Активные поставщики справочника для выпадающего списка. */
  suppliers?: SupplierOption[];
}

export function InlineEditWorkshopNeedRow({
  need,
  showOrderInfo = false,
  bulkSelect = false,
  suppliersEnabled = false,
  suppliers = [],
}: InlineEditWorkshopNeedRowProps) {
  const [state, action] = useFormState(
    updateWorkshopNeedAction.bind(null, need.id),
    initialUpdateWorkshopNeedState,
  );

  // Ref на саму форму строки — нужен, чтобы при сворачивании блока
  // комментария программно сабмитить тот же server-action, что и
  // кнопка «Сохранить» (`requestSubmit`). Так введённый коммент
  // персистится в БД сразу при «Скрыть», а не теряется.
  const formRef = useRef<HTMLFormElement>(null);

  const initialCurrency = (need.quotedCurrency ?? '').toUpperCase();
  const validInitialCurrency = MONEY_CURRENCIES.includes(
    initialCurrency as (typeof MONEY_CURRENCIES)[number],
  )
    ? initialCurrency
    : '';

  // Нитки: расход хранится в метрах, но закупщик работает в ярдах и
  // покупает бобинами (1 боб. = 4000 ярдов). Конверсия — только на
  // фронте; в БД и backend всё остаётся в метрах / цене за метр (см.
  // `./thread-units`). Для остальных единиц (шт / м² / кг / компл)
  // ничего не меняем.
  const isThread = isThreadNeed(need.materialRole);

  // Кнопки: считаются/хранятся поштучно, но закупщик покупает их
  // упаковками. Поле «К закупке» заменяется на «Упаковок» + «Шт/упак»,
  // «Цена за 1 шт» → «Цена за упаковку», «Сумма» = упаковок × цена за
  // упаковку. В БД остаётся поштучно (purchaseQty = упаковок × шт/упак,
  // quotedPrice = цена за упаковку ÷ шт/упак), а штук-в-упаковке
  // хранится отдельной колонкой packSize (см. `./button-units`). Кнопки
  // и нитки взаимоисключающи (нитки — не PACKAGING).
  const isButton = isButtonNeed(
    need.materialRole,
    need.sourceName,
    need.description,
  );

  // Исходные значения в единицах ОТОБРАЖЕНИЯ (для ниток — ярды /
  // цена за бобину; иначе — как в БД). Считаем один раз: если поле
  // не редактировали, при сохранении отправим исходное значение из
  // БД без обратной конверсии — так round-trip метры↔ярды не «плывёт».
  const initialPurchaseDisplay = isThread
    ? metersToYards(need.purchaseQty)
    : (need.purchaseQty ?? '');
  const initialPriceDisplay = isThread
    ? pricePerMeterToBobbin(need.quotedPrice)
    : (need.quotedPrice ?? '');

  // Controlled-state — нужен для preview «Сумма строки» и (для ниток)
  // для обратной конверсии при сохранении.
  const [purchaseQtyValue, setPurchaseQtyValue] = useState<string>(
    initialPurchaseDisplay,
  );
  const [quotedPriceValue, setQuotedPriceValue] = useState<string>(
    initialPriceDisplay,
  );
  const [currency, setCurrency] = useState<string>(validInitialCurrency);

  // Кнопки: исходные значения «Упаковок» / «Шт/упак» / «Цена за
  // упаковку» восстанавливаем из поштучных purchaseQty / quotedPrice и
  // сохранённого packSize.
  const [packSizeValue, setPackSizeValue] = useState<string>(
    need.packSize ?? '',
  );
  const [packagesValue, setPackagesValue] = useState<string>(
    isButton ? piecesToPackages(need.purchaseQty, need.packSize) : '',
  );
  const [packPriceValue, setPackPriceValue] = useState<string>(
    isButton ? pricePerPieceToPack(need.quotedPrice, need.packSize) : '',
  );

  // Комментарий закупщика по умолчанию скрыт. Кнопка-toggle
  // показывает текущее значение (если есть) и раскрывает textarea
  // для редактирования. SaaS-итерация: одинаково в lines/orders.
  //
  // Поле controlled (`commentValue`): иначе при сворачивании
  // uncontrolled textarea демонтируется и заменяется hidden-input
  // со старым значением из БД — введённый текст терялся бы.
  const [commentValue, setCommentValue] = useState<string>(
    need.comment ?? '',
  );
  const [commentOpen, setCommentOpen] = useState<boolean>(false);
  const hasComment = commentValue.trim().length > 0;

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

  // Подпись единицы и поля цены. Для ниток — ярды / «Цена за 1 боб.»;
  // иначе — единица из БД и «Цена за 1 <unit>».
  const unitLabel = isThread ? 'ярд' : need.unit;
  const priceLabel = isThread
    ? 'Цена за 1 боб.'
    : isButton
      ? 'Цена за упаковку'
      : formatPriceLabel(need.unit);

  // «Нужно» (calculatedQty) в единицах отображения.
  const calcQtyDisplay = isThread
    ? metersToYards(need.calculatedQty)
    : trimDecimal(need.calculatedQty);

  // Line total preview. Для ниток: цена за бобину, количество в ярдах,
  // сумма = (ярды / 4000) × цена за боб. Иначе: цена за единицу × кол-во.
  const purchaseQtyNum = parseDecimalString(purchaseQtyValue);
  const baseQtyNum =
    purchaseQtyNum ?? parseDecimalString(calcQtyDisplay);
  const priceNum = parseDecimalString(quotedPriceValue);
  // Сумма: для кнопок — упаковок × цена за упаковку; для ниток —
  // (ярды / 4000) × цена за боб.; иначе — цена за единицу × кол-во.
  let lineTotal: number | null;
  if (isButton) {
    const packagesNum = parseDecimalString(packagesValue);
    const packPriceNum = parseDecimalString(packPriceValue);
    lineTotal =
      packagesNum !== null && packPriceNum !== null
        ? packagesNum * packPriceNum
        : null;
  } else if (priceNum !== null && baseQtyNum !== null) {
    lineTotal = isThread
      ? (baseQtyNum / YARDS_PER_BOBBIN) * priceNum
      : priceNum * baseQtyNum;
  } else {
    lineTotal = null;
  }
  const symbol = currencySymbol(currency);

  // Кнопки: на backend уходит поштучно. purchaseQty (шт) = упаковок ×
  // шт/упак, quotedPrice (за 1 шт) = цена за упаковку ÷ шт/упак,
  // packSize = шт/упак. Пустые поля → '' (Zod нормализует в null).
  const submitButtonQty =
    packagesValue.trim() === '' || packSizeValue.trim() === ''
      ? ''
      : packagesToPieces(packagesValue, packSizeValue);
  const submitButtonPrice =
    packPriceValue.trim() === '' || packSizeValue.trim() === ''
      ? ''
      : pricePerPackToPiece(packPriceValue, packSizeValue);

  // Значения, которые реально уйдут на backend (всегда в метрах /
  // цене за метр). Если поле не редактировали — отправляем исходное
  // значение из БД, чтобы конверсия туда-обратно не округляла.
  const submitPurchaseQty = !isThread
    ? null
    : purchaseQtyValue === initialPurchaseDisplay
      ? (need.purchaseQty ?? '')
      : yardsToMeters(purchaseQtyValue);
  const submitQuotedPrice = !isThread
    ? null
    : quotedPriceValue === initialPriceDisplay
      ? (need.quotedPrice ?? '')
      : pricePerBobbinToMeter(quotedPriceValue);

  // Базовый класс формы: в lines-mode — старый grid с превью/клиентом,
  // в orders-mode — компактный 10-колоночный SaaS-grid.
  const rootClassName = showOrderInfo
    ? 'workshop-need-line workshop-need-inline-form workshop-need-line--with-order'
    : 'workshop-order-need-row workshop-need-inline-form';

  return (
    <form
      ref={formRef}
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
          {calcQtyDisplay}
          {unitLabel ? ` ${unitLabel}` : ''}
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
        {isButton ? (
          <>
            {/* Кнопки покупаются упаковками. Видимые поля «Упаковок» /
                «Шт/упак» НЕ сабмитятся напрямую — backend получает
                поштучный purchaseQty и packSize из скрытых полей ниже. */}
            <label
              htmlFor={`wnq-${need.id}`}
              className="workshop-need-line__hint"
            >
              Упаковок
            </label>
            <input
              id={`wnq-${need.id}`}
              type="text"
              inputMode="decimal"
              value={packagesValue}
              onChange={(e) => setPackagesValue(e.target.value)}
              placeholder="0"
              disabled={isCancelled || isLockedByPo}
            />
            <label
              htmlFor={`wnps-${need.id}`}
              className="workshop-need-line__hint"
            >
              Шт/упак
            </label>
            <input
              id={`wnps-${need.id}`}
              type="text"
              inputMode="decimal"
              value={packSizeValue}
              onChange={(e) => setPackSizeValue(e.target.value)}
              placeholder="0"
              disabled={isCancelled || isLockedByPo}
            />
            {!(isCancelled || isLockedByPo) && (
              <>
                <input
                  type="hidden"
                  name="purchaseQty"
                  value={submitButtonQty}
                />
                <input
                  type="hidden"
                  name="packSize"
                  value={packSizeValue.trim()}
                />
              </>
            )}
          </>
        ) : (
          <>
            <label
              htmlFor={`wnq-${need.id}`}
              className="workshop-need-line__hint"
            >
              К закупке{isThread ? ', ярд' : ''}
            </label>
            <input
              id={`wnq-${need.id}`}
              /* Для ниток видимый input в ярдах НЕ сабмитим — backend
                 получает метры из скрытого поля ниже. */
              name={isThread ? undefined : 'purchaseQty'}
              type="text"
              inputMode="decimal"
              value={purchaseQtyValue}
              onChange={(e) => setPurchaseQtyValue(e.target.value)}
              placeholder={calcQtyDisplay}
              disabled={isCancelled || isLockedByPo}
            />
            {isThread && !(isCancelled || isLockedByPo) && (
              <input
                type="hidden"
                name="purchaseQty"
                value={submitPurchaseQty ?? ''}
              />
            )}
          </>
        )}
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
          /* Для ниток видимый input — цена за бобину; для кнопок — цена
             за упаковку. Backend получает цену за единицу (метр / штуку)
             из скрытого поля ниже, поэтому видимый input не сабмитим. */
          name={isThread || isButton ? undefined : 'quotedPrice'}
          type="text"
          inputMode="decimal"
          value={isButton ? packPriceValue : quotedPriceValue}
          onChange={(e) =>
            isButton
              ? setPackPriceValue(e.target.value)
              : setQuotedPriceValue(e.target.value)
          }
          placeholder="0.00"
          disabled={isCancelled}
          aria-describedby={`wnp-hint-${need.id}`}
        />
        {isThread && !isCancelled && (
          <input type="hidden" name="quotedPrice" value={submitQuotedPrice ?? ''} />
        )}
        {isButton && !isCancelled && (
          <input type="hidden" name="quotedPrice" value={submitButtonPrice} />
        )}
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

      {/* === Supplier: select из справочника (если включён модуль) + text fallback === */}
      <div
        className={
          showOrderInfo
            ? 'workshop-need-line__cell workshop-need-line__cell--supplier'
            : 'workshop-order-need-row__cell workshop-order-need-row__cell--supplier workshop-order-need-row__field'
        }
        data-cell="supplier"
      >
        <label
          htmlFor={
            suppliersEnabled ? `wnss-${need.id}` : `wns-${need.id}`
          }
          className="workshop-need-line__hint"
        >
          Поставщик
        </label>
        {suppliersEnabled && (
          <select
            id={`wnss-${need.id}`}
            name="selectedSupplierId"
            defaultValue={need.selectedSupplierId ?? ''}
            disabled={isCancelled || isLockedByPo}
            style={{ marginBottom: 4 }}
          >
            <option value="">— из справочника —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {/* Текущий выбранный поставщик, если он неактивен и не
                попал в список активных — чтобы выбор не «исчезал». */}
            {need.selectedSupplierId &&
              need.selectedSupplierName &&
              !suppliers.some((s) => s.id === need.selectedSupplierId) && (
                <option value={need.selectedSupplierId}>
                  {need.selectedSupplierName} (неактивен)
                </option>
              )}
          </select>
        )}
        <input
          id={`wns-${need.id}`}
          name="supplierNameText"
          type="text"
          maxLength={200}
          defaultValue={need.supplierNameText ?? ''}
          placeholder={
            suppliersEnabled
              ? 'или текстом (fallback)'
              : need.selectedSupplierName
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
          onClick={() => {
            // При сворачивании (открыт → закрыт) авто-сохраняем строку
            // на backend, чтобы введённый коммент персистился сразу.
            if (commentOpen && !isCancelled) {
              formRef.current?.requestSubmit();
            }
            setCommentOpen((v) => !v);
          }}
          title={
            hasComment
              ? `Комментарий: ${commentValue}`
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
            value={commentValue}
            onChange={(e) => setCommentValue(e.target.value)}
            placeholder="—"
            disabled={isCancelled}
            rows={2}
          />
        </div>
      ) : (
        <>
          <input type="hidden" name="comment" value={commentValue} />
          {hasComment && (
            <div
              className="workshop-need-line__cell workshop-order-need-row__comment workshop-order-need-row__comment--readonly"
              data-cell="comment-view"
            >
              <p className="workshop-order-need-row__comment-text">
                {renderCommentWithLinks(commentValue)}
              </p>
            </div>
          )}
        </>
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
