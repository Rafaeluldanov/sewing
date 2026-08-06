'use client';

/**
 * Inline-редактирование строки потребности.
 *
 * Этап «Себестоимость заказа» (см.
 * `docs/recon-soft-integration.md §«Себестоимость заказа»`).
 *
 * Закупщик правит «К закупке», цену, валюту, поставщика, дату прямо
 * в строке внутри карточки заказа на `/admin/workshop-needs` — без
 * перехода на отдельную карточку. Используется тот же server-action
 * `updateWorkshopNeedAction`, что и в полной форме редактирования
 * `/admin/workshop-needs/[id]`.
 *
 * Зональный layout «Расчёт / Закупка / Логистика» (`.wn-zrow`):
 *   - read-only вывод системы — в зоне «Расчёт»; ввод закупщика —
 *     в «Закупке» (qty / цена / валюта / сумма) и «Логистике»
 *     (поставщик / дата / статус / сохранить).
 *   - label у поля цены — «Цена за 1 <unit>»; line total считается
 *     в UI как `finalQty × quotedPrice`. Валюта ограничена
 *     `MONEY_CURRENCIES` (RUB / USD).
 *   - комментарий закупщика скрыт по умолчанию: в подвале строки
 *     кнопка-toggle с индикатором; по клику раскрывается textarea.
 *   - в подвале же ссылка «Подробности» → полная карточка
 *     `/admin/workshop-needs/[id]` (связь со справочником
 *     поставщиков, история, аудит). Туда же ведёт клик по зоне
 *     «Расчёт» (drill-in, `ClickableCard`) — зоны ввода
 *     «Закупка»/«Логистика» намеренно НЕ кликабельны, чтобы
 *     случайный клик мимо инпута не увёл со страницы с
 *     несохранённой правкой.
 *   - bulk-чекбокс PO привязан к `bulkSelect` (feature-flag
 *     `purchase-orders`, см. `page.tsx`).
 *
 * Прежний построчный режим (`?view=lines`) убран — осталась
 * единственная группировка по заказу.
 */

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useRef, useState } from 'react';
import {
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
  type WorkshopNeedListItemDto,
  type WorkshopNeedStatus,
} from '@sewing/shared/workshop-needs';
import { ClickableCard } from '@/components/ui/clickable-card';
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

/** Save-кнопка зонального orders-макета (иконка ✓, `.wn-save`). */
function ZoneSaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="wn-save"
      disabled={pending}
      title="Сохранить изменения"
      aria-label="Сохранить"
    >
      {pending ? '…' : <CheckCircle2 size={16} strokeWidth={1.8} aria-hidden />}
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
   * Показывать ли чекбокс bulk-PO. Включается feature-flag
   * `purchase-orders` (см. `page.tsx` → `OrdersView`).
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
  const isThread = isThreadNeed(need.materialRole, need.unit);

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
  // packSize = шт/упак.
  //
  // На backend пустое значение означает «очистить поле», а отсутствие
  // поля — «не трогать» (`trackOptional`: absent → changed=false).
  // Поэтому различаем два разных «пусто»:
  //   ''   — закупщик стёр значение сам, очистку передаём;
  //   null — пересчитать нечем («Шт/упак» пуст), поле не отправляем.
  //
  // Раньше скрытые поля рендерились всегда и без «Шт/упак» уходили
  // пустыми, поэтому ЛЮБОЕ сохранение строки — даже правка одного
  // поставщика — обнуляло согласованное «К закупке» и цену.
  const canConvertPacks = packSizeValue.trim() !== '';
  const submitButtonQty =
    packagesValue.trim() === ''
      ? '' // закупщик очистил «Упаковок» — так и передаём
      : canConvertPacks
        ? packagesToPieces(packagesValue, packSizeValue)
        : null; // «Шт/упак» пуст — из упаковок в штуки не перевести
  const submitButtonPrice =
    packPriceValue.trim() === ''
      ? ''
      : canConvertPacks
        ? pricePerPackToPiece(packPriceValue, packSizeValue)
        : null;

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

  // Secondary-строка описания: размер фурнитуры · материал · цвет
  // (см. ТЗ §5). Считаем один раз — переиспользуется в обоих макетах.
  const descSecondaryParts: string[] = [];
  if (need.hardwareSizeText) descSecondaryParts.push(need.hardwareSizeText);
  if (need.hardwareMaterialText)
    descSecondaryParts.push(need.hardwareMaterialText);
  if (need.selectedColorText)
    descSecondaryParts.push(`цвет ${need.selectedColorText}`);
  const descSecondary =
    descSecondaryParts.length > 0 ? descSecondaryParts.join(' · ') : null;

  // ---------------------------------------------------------------------------
  // Зональная строка «Расчёт / Закупка / Логистика» (см. globals.css
  // `.wn-zrow`). Поля сгруппированы по смыслу, read-only выводы вынесены
  // в чипы, на узкой ширине зоны переносятся в стек целиком.
  // ---------------------------------------------------------------------------
  return (
    <form
      ref={formRef}
      action={action}
      className="wn-zrow workshop-need-inline-form"
      data-need-id={need.id}
      data-variant="orders"
    >
      {/*
        === ЗОНА: Расчёт (read-only вывод системы) ===

        Drill-in: клик по этой зоне ведёт туда же, куда ссылка
        «Подробности» в подвале — на карточку `/admin/workshop-needs/[id]`.
        Кликабельна ИМЕННО зона «Расчёт» (read-only вывод + название
        материала), а не вся строка: зоны «Закупка»/«Логистика» — это
        поля ввода закупщика, и случайный уход со страницы по клику
        мимо инпута потерял бы несохранённую правку. Клики по чекбоксу
        bulk-PO внутри зоны не перехватываются (см. `ClickableCard`).
      */}
      <ClickableCard
        as="section"
        className="wn-zone wn-zone--calc"
        href={detailHref}
        ariaLabel={`Подробности потребности: ${need.description}`}
      >
        <div className="wn-zone__cap">Расчёт</div>
        <div className="wn-zone__body wn-zone__body--calc">
          <div className="wn-desc">
            <div className="wn-desc__row">
              {bulkSelect && <BulkCreatePoCheckbox need={need} />}
              {need.materialImageUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  className="wn-desc__img"
                  src={need.materialImageUrl}
                  alt={need.sourceName ?? need.description}
                />
              )}
              <span className="wn-desc__text">{need.description}</span>
              {/* Фича «Варианты просчёта»: строки разных вариантов
                  сосуществуют — метка показывает, к какому варианту
                  относится строка (неактивный дополнительно приглушён;
                  PO под него бэкенд не даст создать). */}
              {need.orderCalculationTitle &&
                need.orderCalculationIsActive === false && (
                  <span
                    className="wn-desc__calc-badge"
                    title="Вариант просчёта сейчас не выбран — заказ поставщику по этой строке недоступен"
                  >
                    {need.orderCalculationTitle}
                  </span>
                )}
            </div>
            {descSecondary && (
              <span className="wn-desc__meta">{descSecondary}</span>
            )}
            {need.calculationNote && (
              <span className="wn-desc__meta" title={need.calculationNote}>
                {need.calculationNote}
              </span>
            )}
            {need.requiresColorSelection && !need.selectedColorText && (
              <span
                className="wn-desc__warning"
                role="status"
                title="Цвет нужно указать в заказе"
              >
                Цвет нужно указать в заказе
              </span>
            )}
          </div>
          <div className="wn-field wn-readout">
            <span className="wn-field__lab">Нужно</span>
            <div className="wn-readout__box">
              {calcQtyDisplay}
              {unitLabel ? ` ${unitLabel}` : ''}
            </div>
          </div>
        </div>
      </ClickableCard>

      {/* === ЗОНА: Закупка (ввод закупщика + итог) === */}
      <section className="wn-zone wn-zone--buy">
        <div className="wn-zone__cap">Закупка</div>
        <div className="wn-zone__body wn-zone__body--buy">
          {isButton ? (
            <>
              <label className="wn-field">
                <span className="wn-field__lab">Упаковок</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={packagesValue}
                  onChange={(e) => setPackagesValue(e.target.value)}
                  placeholder="0"
                  disabled={isCancelled || isLockedByPo}
                />
              </label>
              <label className="wn-field">
                <span className="wn-field__lab">Шт/упак</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={packSizeValue}
                  onChange={(e) => setPackSizeValue(e.target.value)}
                  placeholder="0"
                  disabled={isCancelled || isLockedByPo}
                />
              </label>
              {!(isCancelled || isLockedByPo) && (
                <>
                  {submitButtonQty !== null && (
                    <input
                      type="hidden"
                      name="purchaseQty"
                      value={submitButtonQty}
                    />
                  )}
                  <input type="hidden" name="packSize" value={packSizeValue.trim()} />
                </>
              )}
            </>
          ) : (
            <label className="wn-field">
              <span className="wn-field__lab">
                К закупке{isThread ? ', ярд' : ''}
              </span>
              <input
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
            </label>
          )}

          <label className="wn-field">
            <span className="wn-field__lab">{priceLabel}</span>
            <input
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
            />
            {isThread && !isCancelled && (
              <input type="hidden" name="quotedPrice" value={submitQuotedPrice ?? ''} />
            )}
            {isButton && !isCancelled && submitButtonPrice !== null && (
              <input type="hidden" name="quotedPrice" value={submitButtonPrice} />
            )}
          </label>

          <label className="wn-field">
            <span className="wn-field__lab">Валюта</span>
            <select
              name="quotedCurrency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={isCancelled}
            >
              <option value="">—</option>
              {MONEY_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {MONEY_CURRENCY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>

          <div className="wn-field wn-readout wn-readout--sum">
            <span className="wn-field__lab">Сумма</span>
            <div className="wn-readout__box" aria-live="polite">
              {lineTotal !== null ? (
                <>
                  = {formatLineTotalNumber(lineTotal)}
                  {symbol ? ` ${symbol}` : ''}
                </>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>
      </section>

      {/* === ЗОНА: Логистика (поставщик · дата · статус · сохранить) === */}
      <section className="wn-zone wn-zone--log">
        <div className="wn-zone__cap">Логистика</div>
        <div className="wn-zone__body wn-zone__body--log">
          <div className="wn-field wn-field--supplier">
            <span className="wn-field__lab">Поставщик</span>
            {suppliersEnabled && (
              <select
                name="selectedSupplierId"
                defaultValue={need.selectedSupplierId ?? ''}
                disabled={isCancelled || isLockedByPo}
              >
                <option value="">— из справочника —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
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

          <label className="wn-field wn-field--date">
            <span className="wn-field__lab">Поставка</span>
            <input
              name="expectedDeliveryDate"
              type="date"
              defaultValue={isoToDateInput(need.expectedDeliveryDate)}
              disabled={isCancelled}
            />
          </label>

          <label className="wn-field wn-field--status">
            <span className="wn-field__lab">Статус</span>
            <select
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
          </label>

          <div className="wn-field wn-field--save">
            <span className="wn-field__lab" aria-hidden>
              &nbsp;
            </span>
            <ZoneSaveButton />
          </div>
        </div>
      </section>

      {/* === Подвал: коммент-toggle + раскрытый коммент + алерты === */}
      <div className="wn-zrow__foot">
        <button
          type="button"
          className={`admin-btn admin-btn--ghost workshop-order-need-row__comment-button${
            commentOpen ? ' workshop-order-need-row__comment-button--open' : ''
          }${hasComment ? ' workshop-order-need-row__comment-button--has' : ''}`}
          aria-expanded={commentOpen}
          aria-controls={`wnm-${need.id}`}
          onClick={() => {
            if (commentOpen && !isCancelled) {
              formRef.current?.requestSubmit();
            }
            setCommentOpen((v) => !v);
          }}
          title={hasComment ? `Комментарий: ${commentValue}` : 'Добавить комментарий'}
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
            <span className="workshop-order-need-row__comment-dot" aria-hidden />
          )}
        </button>
        <Link
          href={detailHref}
          className="admin-table__action-link wn-zrow__detail-link"
          title="Открыть полную карточку — связь со справочником поставщиков, история, аудит"
        >
          Подробности
        </Link>
      </div>

      {commentOpen ? (
        <div className="wn-zrow__comment">
          <label htmlFor={`wnm-${need.id}`} className="wn-field__lab">
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
            <div className="wn-zrow__comment-view workshop-order-need-row__comment workshop-order-need-row__comment--readonly">
              <p className="workshop-order-need-row__comment-text">
                {renderCommentWithLinks(commentValue)}
              </p>
            </div>
          )}
        </>
      )}

      {state.error && (
        <div className="error-box wn-zrow__alert" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          <span>{state.error}</span>
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box wn-zrow__alert" role="status">
          <CheckCircle2 size={14} strokeWidth={1.6} aria-hidden />
          <span>{state.successMessage}</span>
        </div>
      )}
    </form>
  );
}

export default InlineEditWorkshopNeedRow;
