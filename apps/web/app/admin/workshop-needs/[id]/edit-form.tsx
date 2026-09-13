'use client';

/**
 * Форма редактирования потребности цеха (`/admin/workshop-needs/[id]`).
 *
 * Закупщик правит руками:
 *   - purchaseQty (сколько реально купить)
 *   - supplierNameText / purchaseItemNameText (этап 4А — текстовый fallback)
 *   - selectedSupplierId / selectedSupplierCatalogItemId (этап 5 —
 *     связь со справочником поставщиков)
 *   - quotedPrice / quotedCurrency / expectedDeliveryDate
 *   - status (CALCULATED → REVIEWED → PURCHASE_PLANNED → CANCELLED)
 *   - comment
 *
 * Кнопка «Отменить» рядом со submit делает status = CANCELLED через
 * отдельный action (POST /api/workshop-needs/:id/cancel).
 *
 * Этап 5 «Поставщики»:
 *   - select поставщика заполняется из активных Supplier (передаются
 *     RSC-ом сверху);
 *   - select номенклатуры заполняется из catalog уже выбранного
 *     поставщика (тоже RSC-side);
 *   - при смене supplier select каталога замораживается и закупщик
 *     должен сначала сохранить выбор, чтобы перезагрузить каталог
 *     нового поставщика. Это сознательно простой UX: заводить
 *     fetch-on-change (cross-fetch /api/suppliers/:id/catalog с
 *     клиента) — за пределами этого этапа.
 *   - текстовые `supplierNameText`/`purchaseItemNameText` остаются
 *     fallback-ом и НЕ перезаписываются backend-ом при выборе
 *     `selectedSupplierId` (см. ТЗ §6 «Текстовые поля»).
 */

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import {
  MONEY_CURRENCIES,
  MONEY_CURRENCY_LABELS,
} from '@sewing/shared/money';
import {
  WORKSHOP_NEED_STATUSES,
  WORKSHOP_NEED_STATUS_LABELS,
  type WorkshopNeedDto,
} from '@sewing/shared/workshop-needs';
import type {
  SupplierCatalogItemDto,
  SupplierListItemDto,
} from '@sewing/shared/suppliers';
import {
  cancelWorkshopNeedAction,
  updateWorkshopNeedAction,
} from '../actions';
import {
  initialCancelWorkshopNeedState,
  initialUpdateWorkshopNeedState,
} from '../form-state';
import {
  isThreadNeed,
  metersToYards,
  yardsToMeters,
  pricePerMeterToBobbin,
  pricePerBobbinToMeter,
} from '../thread-units';
import {
  isButtonNeed,
  isPackMode,
  packFieldToSubmit,
  packagesToPieces,
  piecesToPackages,
  pricePerPackToPiece,
  pricePerPieceToPack,
} from '../button-units';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function CancelButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn"
      disabled={pending}
      title="Перевести в статус «Отменено»"
    >
      {pending ? 'Отменяем…' : 'Отменить'}
    </button>
  );
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // YYYY-MM-DD для <input type="date">.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function EditWorkshopNeedForm({
  need,
  suppliersEnabled = false,
  suppliers = [],
  selectedSupplierCatalog = [],
}: {
  need: WorkshopNeedDto;
  suppliersEnabled?: boolean;
  suppliers?: SupplierListItemDto[];
  selectedSupplierCatalog?: SupplierCatalogItemDto[];
}) {
  const [updateState, updateAction] = useFormState(
    updateWorkshopNeedAction.bind(null, need.id),
    initialUpdateWorkshopNeedState,
  );
  const [cancelState, cancelAction] = useFormState(
    cancelWorkshopNeedAction.bind(null, need.id),
    initialCancelWorkshopNeedState,
  );

  // Локальное состояние для управления списком catalog-позиций:
  // когда закупщик меняет поставщика в селекте, мы скрываем
  // несовместимый каталог (он пришёл с сервера для предыдущего
  // supplierId). После save — RSC перезагрузит правильный набор.
  const [supplierIdLocal, setSupplierIdLocal] = useState<string>(
    need.selectedSupplierId ?? '',
  );
  const supplierChangedSinceLoad =
    supplierIdLocal !== (need.selectedSupplierId ?? '');
  const showCatalogSelect =
    suppliersEnabled &&
    supplierIdLocal !== '' &&
    !supplierChangedSinceLoad &&
    selectedSupplierCatalog.length > 0;

  // Нитки: показываем «К закупке» в ярдах и цену за бобину
  // (1 боб. = 4000 ярдов), но в БД храним метры / цену за метр —
  // см. `../thread-units`. Конверсия только на фронте, остальные
  // единицы не трогаем.
  const isThread = isThreadNeed(need.materialRole, need.unit);
  // Кнопки: покупаются упаковками. «К закупке» → «Упаковок» + «Шт/упак»,
  // «Цена за 1 шт» → «Цена за упаковку». В БД остаётся поштучно +
  // отдельная колонка packSize (см. `../button-units`).
  const isButton = isButtonNeed(
    need.materialRole,
    need.sourceName,
    need.description,
  );
  // Аудит движка расчёта 13.09.2026, N2-1: режим упаковок — только при
  // СОХРАНЁННОМ packSize (его не пишут ERP `:price`/`:qty` и окно правки
  // во вкладке заказа). Без него из штук упаковки не вывести: раньше
  // «Упаковок»/«Цена за упаковку» показывались пустыми при живых
  // purchaseQty/quotedPrice, а скрытые поля уносили пустоту как «стёр».
  // Такая строка показывает обычные «К закупке» / «Цена за 1 шт» с
  // исходными значениями + поле «Штук в упаковке».
  const packMode = isPackMode(isButton, need.packSize);
  const initialPurchaseDisplay = isThread
    ? metersToYards(need.purchaseQty)
    : (need.purchaseQty ?? '');
  const initialPriceDisplay = isThread
    ? pricePerMeterToBobbin(need.quotedPrice)
    : (need.quotedPrice ?? '');
  const [purchaseQtyValue, setPurchaseQtyValue] = useState<string>(
    initialPurchaseDisplay,
  );
  const [quotedPriceValue, setQuotedPriceValue] = useState<string>(
    initialPriceDisplay,
  );
  // Кнопки: «Упаковок» / «Шт/упак» / «Цена за упаковку». Исходные
  // значения держим отдельно: поле уходит на backend только если
  // отличается от них (N2-1).
  const initialPackSize = need.packSize ?? '';
  const initialPackagesDisplay = packMode
    ? piecesToPackages(need.purchaseQty, need.packSize)
    : '';
  const initialPackPriceDisplay = packMode
    ? pricePerPieceToPack(need.quotedPrice, need.packSize)
    : '';
  const [packSizeValue, setPackSizeValue] = useState<string>(initialPackSize);
  const [packagesValue, setPackagesValue] = useState<string>(
    initialPackagesDisplay,
  );
  const [packPriceValue, setPackPriceValue] = useState<string>(
    initialPackPriceDisplay,
  );
  // Аудит движка расчёта 13.09.2026, N2-1: `null` — поле не отправлять
  // (не менялось / «Шт/упак» стёрт), `''` — закупщик стёр сам. Раньше
  // скрытые поля рендерились всегда и при пустом «Шт/упак» уносили
  // пустоту → backend писал null в purchaseQty/quotedPrice.
  const submitButtonQty = packMode
    ? packFieldToSubmit({
        value: packagesValue,
        initialValue: initialPackagesDisplay,
        packSize: packSizeValue,
        initialPackSize,
        convert: packagesToPieces,
      })
    : null;
  const submitButtonPrice = packMode
    ? packFieldToSubmit({
        value: packPriceValue,
        initialValue: initialPackPriceDisplay,
        packSize: packSizeValue,
        initialPackSize,
        convert: pricePerPackToPiece,
      })
    : null;
  // Подсказки «в БД хранится поштучно» — по текущим значениям,
  // независимо от того, уйдёт ли поле на backend.
  const packPiecesPreview = packagesToPieces(packagesValue, packSizeValue);
  const packUnitPricePreview = pricePerPackToPiece(
    packPriceValue,
    packSizeValue,
  );
  const calcQtyDisplay = isThread
    ? metersToYards(need.calculatedQty)
    : need.calculatedQty;
  const purchaseUnitLabel = isThread ? 'ярд' : need.unit;
  // Значения для backend — всегда метры / цена за метр. Неизменённое
  // поле уходит исходным значением, чтобы не округлять round-trip.
  const submitPurchaseQty = isThread
    ? purchaseQtyValue === initialPurchaseDisplay
      ? (need.purchaseQty ?? '')
      : yardsToMeters(purchaseQtyValue)
    : null;
  const submitQuotedPrice = isThread
    ? quotedPriceValue === initialPriceDisplay
      ? (need.quotedPrice ?? '')
      : pricePerBobbinToMeter(quotedPriceValue)
    : null;

  return (
    <>
      <form action={updateAction} className="admin-form">
        <div className="admin-form-grid">
          {packMode ? (
            <>
              <div className="admin-field">
                <label htmlFor="need-packages">Упаковок</label>
                <input
                  id="need-packages"
                  type="text"
                  inputMode="decimal"
                  value={packagesValue}
                  onChange={(e) => setPackagesValue(e.target.value)}
                  placeholder="напр. 10"
                />
                {/* Кнопки покупаются упаковками: видимые поля не сабмитим,
                    backend получает поштучный purchaseQty + packSize из
                    скрытых полей. N2-1: purchaseQty — только если
                    тронули (null = не отправлять). */}
                {submitButtonQty !== null && (
                  <input
                    type="hidden"
                    name="purchaseQty"
                    value={submitButtonQty}
                  />
                )}
                <input
                  type="hidden"
                  name="packSize"
                  value={packSizeValue.trim()}
                />
              </div>
              <div className="admin-field">
                <label htmlFor="need-packSize">Штук в упаковке</label>
                <input
                  id="need-packSize"
                  type="text"
                  inputMode="decimal"
                  value={packSizeValue}
                  onChange={(e) => setPackSizeValue(e.target.value)}
                  placeholder="напр. 100"
                />
                <small className="admin-muted" style={{ marginTop: 4 }}>
                  В БД хранится поштучно: к закупке ={' '}
                  {packPiecesPreview || '—'} шт.
                </small>
              </div>
            </>
          ) : (
            <>
              <div className="admin-field">
                <label htmlFor="need-purchaseQty">
                  К закупке ({purchaseUnitLabel})
                </label>
                <input
                  id="need-purchaseQty"
                  /* Для ниток видимый input в ярдах НЕ сабмитим — backend
                     получает метры из скрытого поля ниже. */
                  name={isThread ? undefined : 'purchaseQty'}
                  type="text"
                  inputMode="decimal"
                  value={isThread ? purchaseQtyValue : undefined}
                  defaultValue={isThread ? undefined : (need.purchaseQty ?? '')}
                  onChange={
                    isThread
                      ? (e) => setPurchaseQtyValue(e.target.value)
                      : undefined
                  }
                  placeholder={`напр. ${calcQtyDisplay}`}
                />
                {isThread && (
                  <input
                    type="hidden"
                    name="purchaseQty"
                    value={submitPurchaseQty ?? ''}
                  />
                )}
              </div>
              {/* N2-1: кнопочная строка без сохранённого packSize — штуки
                  как есть + поле «Штук в упаковке»; после его сохранения
                  форма перезагрузится в режиме упаковок. */}
              {isButton && (
                <div className="admin-field">
                  <label htmlFor="need-packSize">Штук в упаковке</label>
                  <input
                    id="need-packSize"
                    type="text"
                    inputMode="decimal"
                    value={packSizeValue}
                    onChange={(e) => setPackSizeValue(e.target.value)}
                    placeholder="напр. 100"
                  />
                  <input
                    type="hidden"
                    name="packSize"
                    value={packSizeValue.trim()}
                  />
                  <small className="admin-muted" style={{ marginTop: 4 }}>
                    Укажите штук в упаковке — после сохранения «К закупке» и
                    цена будут вводиться упаковками.
                  </small>
                </div>
              )}
            </>
          )}
          <div className="admin-field">
            <label htmlFor="need-status">Статус</label>
            <select
              id="need-status"
              name="status"
              defaultValue={need.status}
              disabled={Boolean(need.erpManagedAt)}
              title={need.erpManagedAt ? `Статус ведёт ERP (заказ ${need.erpPurchaseOrderRef ?? ''})` : undefined}
            >
              {WORKSHOP_NEED_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {WORKSHOP_NEED_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {suppliersEnabled && (
          <div className="admin-form-grid">
            <div className="admin-field">
              <label htmlFor="need-selected-supplier">
                Поставщик из справочника
              </label>
              <CreatableSelect
                entity="supplier"
                id="need-selected-supplier"
                name="selectedSupplierId"
                value={supplierIdLocal}
                onValueChange={setSupplierIdLocal}
                existingValues={suppliers.map((s) => s.id)}
              >
                <option value="">— не выбран —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {/* Если выбранный supplier неактивен и потому не попал в
                    список активных, всё равно показываем его как
                    отдельную опцию, чтобы текущий выбор не «исчез». */}
                {need.selectedSupplierId &&
                  need.selectedSupplierName &&
                  !suppliers.some((s) => s.id === need.selectedSupplierId) && (
                    <option value={need.selectedSupplierId}>
                      {need.selectedSupplierName} (неактивен)
                    </option>
                  )}
              </CreatableSelect>
              {supplierChangedSinceLoad && (
                <small
                  className="admin-muted"
                  style={{ display: 'block', marginTop: 4 }}
                >
                  После сохранения каталог нового поставщика подгрузится.
                </small>
              )}
            </div>
            <div className="admin-field">
              <label htmlFor="need-selected-item">
                Номенклатура поставщика
              </label>
              {showCatalogSelect ? (
                <select
                  id="need-selected-item"
                  name="selectedSupplierCatalogItemId"
                  defaultValue={need.selectedSupplierCatalogItemId ?? ''}
                >
                  <option value="">— не выбрано —</option>
                  {selectedSupplierCatalog.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.supplierArticle ? ` · ${c.supplierArticle}` : ''}
                      {c.lastPrice
                        ? ` · ${c.lastPrice}${
                            c.currency ? ` ${c.currency}` : ''
                          }/${c.unit}`
                        : ''}
                    </option>
                  ))}
                  {/* То же, что и для supplier-а: показываем привязанную
                      позицию, даже если она архивирована. */}
                  {need.selectedSupplierCatalogItemId &&
                    !selectedSupplierCatalog.some(
                      (c) => c.id === need.selectedSupplierCatalogItemId,
                    ) && (
                      <option value={need.selectedSupplierCatalogItemId}>
                        {need.selectedSupplierCatalogItemName ?? '—'} (архив)
                      </option>
                    )}
                </select>
              ) : (
                <>
                  {/* Скрытое поле, чтобы при сохранении явно очистить
                      связь, если поставщик сброшен. Если supplier
                      просто не выбран — отправляем пустую строку,
                      backend нормализует в null. */}
                  <input
                    type="hidden"
                    name="selectedSupplierCatalogItemId"
                    value=""
                  />
                  <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
                    {supplierIdLocal === ''
                      ? 'Сначала выберите поставщика.'
                      : supplierChangedSinceLoad
                        ? 'Сохраните выбор поставщика, чтобы загрузить его каталог.'
                        : 'У поставщика пока нет активной номенклатуры.'}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="need-supplier">Поставщик (текстом)</label>
            <input
              id="need-supplier"
              name="supplierNameText"
              type="text"
              maxLength={200}
              defaultValue={need.supplierNameText ?? ''}
              placeholder={
                need.selectedSupplierName
                  ? `Сейчас: ${need.selectedSupplierName}`
                  : 'Свободный текст'
              }
            />
            <small className="admin-muted" style={{ marginTop: 4 }}>
              Используется как fallback, если поставщик не выбран в
              справочнике.
            </small>
          </div>
          <div className="admin-field">
            <label htmlFor="need-item">Номенклатура (текстом)</label>
            <input
              id="need-item"
              name="purchaseItemNameText"
              type="text"
              maxLength={200}
              defaultValue={need.purchaseItemNameText ?? ''}
              placeholder={
                need.selectedSupplierCatalogItemName
                  ? `Сейчас: ${need.selectedSupplierCatalogItemName}`
                  : 'Например: Кулирка 180 г/м² чёрный'
              }
            />
            <small className="admin-muted" style={{ marginTop: 4 }}>
              Fallback к ручной номенклатуре, если позиция не выбрана.
            </small>
          </div>
        </div>

        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="need-price">
              {/*
                Этап «Цена за единицу» (см.
                `apps/web/app/admin/workshop-needs/inline-edit-row.tsx`):
                подпись поля — «Цена за 1 <unit>». Источник истины
                по полю — `WorkshopNeed.quotedPrice` = цена за 1
                единицу `unit` (за 1 кг / 1 шт / 1 м / 1 компл),
                не за весь объём. Backend / DTO / расчёт не меняли
                — это только UI-подпись.
              */}
              {isThread
                ? 'Цена за 1 боб.'
                : packMode
                  ? 'Цена за упаковку'
                  : `Цена за 1 ${need.unit}`}
            </label>
            <input
              id="need-price"
              /* Для ниток видимый input — цена за бобину; для кнопок в
                 режиме упаковок — цена за упаковку. Backend получает цену
                 за единицу из скрытого поля ниже, поэтому видимый input
                 не сабмитим. */
              name={isThread || packMode ? undefined : 'quotedPrice'}
              type="text"
              inputMode="decimal"
              value={
                isThread
                  ? quotedPriceValue
                  : packMode
                    ? packPriceValue
                    : undefined
              }
              defaultValue={
                isThread || packMode ? undefined : (need.quotedPrice ?? '')
              }
              onChange={
                isThread
                  ? (e) => setQuotedPriceValue(e.target.value)
                  : packMode
                    ? (e) => setPackPriceValue(e.target.value)
                    : undefined
              }
              placeholder="0.00"
            />
            {isThread && (
              <input
                type="hidden"
                name="quotedPrice"
                value={submitQuotedPrice ?? ''}
              />
            )}
            {/* N2-1: quotedPrice для упаковок — только если тронули. */}
            {packMode && submitButtonPrice !== null && (
              <input
                type="hidden"
                name="quotedPrice"
                value={submitButtonPrice}
              />
            )}
            <small className="admin-muted" style={{ marginTop: 4 }}>
              {isThread
                ? 'Цена за 1 бобину (4000 ярдов), не за весь объём.'
                : packMode
                  ? 'Цена за упаковку. В БД хранится цена за 1 шт ='
                    + ` ${packUnitPricePreview || '—'}.`
                  : `Цена за 1 ${need.unit}, не за весь объём.`}
            </small>
          </div>
          <div className="admin-field">
            <label htmlFor="need-currency">Валюта</label>
            {/*
              Этап «Себестоимость заказа»: select закрытый по
              `MONEY_CURRENCIES` (RUB / USD). Раньше здесь был
              свободный текст-input, и валюта строки могла попасть
              в БД как «UAH» / «EUR» / «р». Это ломало пересчёт в
              рубли при `completeCalculation`. Теперь backend
              принимает только `RUB`/`USD`/`null` (см.
              `MoneyCurrencySchema`); UI рендерит ровно то же.
              `defaultValue` берётся из `need.quotedCurrency` —
              поле подтягивается обратно после сохранения.
            */}
            <select
              id="need-currency"
              name="quotedCurrency"
              defaultValue={
                MONEY_CURRENCIES.includes(
                  (need.quotedCurrency ?? '').toUpperCase() as (typeof MONEY_CURRENCIES)[number],
                )
                  ? (need.quotedCurrency ?? '').toUpperCase()
                  : ''
              }
            >
              <option value="">— не выбрана —</option>
              {MONEY_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {MONEY_CURRENCY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="need-eta">Ожидаемая дата</label>
            <input
              id="need-eta"
              name="expectedDeliveryDate"
              type="date"
              defaultValue={isoToDateInput(need.expectedDeliveryDate)}
            />
          </div>
        </div>

        <div className="admin-field">
          <label htmlFor="need-comment">Комментарий закупщика</label>
          <textarea
            id="need-comment"
            name="comment"
            rows={3}
            maxLength={1000}
            defaultValue={need.comment ?? ''}
          />
        </div>

        {updateState.error && (
          <div className="error-box" role="alert">
            <XCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
            {updateState.error}
          </div>
        )}
        {updateState.ok && updateState.successMessage && (
          <div className="success-box" role="status">
            <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
            {updateState.successMessage}
          </div>
        )}

        <div className="admin-actions-row">
          <SubmitButton />
        </div>
      </form>

      {/*
        Отдельный form для action «Отменить». Не вкладываем в основную
        форму, чтобы кнопка не сабмитила её случайно. Action возвращает
        только { ok | error }, без UI-сообщений — статус и так
        обновится после redirect/revalidate.
      */}
      <form action={cancelAction} style={{ marginTop: 12 }}>
        {cancelState.error && (
          <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
            <XCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
            {cancelState.error}
          </div>
        )}
        {need.status !== 'CANCELLED' && (
          <div className="admin-actions-row">
            <CancelButton />
          </div>
        )}
      </form>
    </>
  );
}
