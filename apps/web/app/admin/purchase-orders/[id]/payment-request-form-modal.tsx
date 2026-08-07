'use client';

/**
 * `PaymentRequestFormModal` — общая модалка заявки на оплату для двух
 * режимов:
 *   - `create` — создание новой заявки (триггерится из
 *     `CreatePaymentRequestDialog`, кнопка в шапке карточки);
 *   - `edit`   — редактирование существующей (триггерится из
 *     `PaymentRequestRowActions`, карандаш в строке таблицы).
 *
 * Собирает:
 *   - сумму заявки + валюту;
 *   - реквизиты поставщика (снимок, редактируемы);
 *   - этапы оплаты: процент → авто-сумма (`round(amount × % / 100, 2)`),
 *     плановая дата, комментарий. «Σ процентов = 100%» — мягкое
 *     предупреждение;
 *   - вложения: в edit-режиме показываем прежние (можно убрать) +
 *     добавляем новые; в create — только новые;
 *   - статус (только в edit-режиме).
 *
 * FormData (payload JSON + новые files) форвардится в server action одним
 * аргументом (Next 14 не принимает File[] top-level).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Paperclip, Plus, Trash2, Upload, X } from 'lucide-react';
import {
  SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT,
  SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES,
  SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT,
  SUPPLIER_PAYMENT_REQUEST_STATUSES,
  SUPPLIER_PAYMENT_REQUEST_STATUS_LABELS,
  type SupplierPaymentRequestStatus,
} from '@sewing/shared/supplier-payment-requests';
import type { SupplierListItemDto } from '@sewing/shared/suppliers';
import {
  CASH_FLOW_DIRECTION_LABELS,
  type CashFlowItemDto,
} from '@sewing/shared/treasury';
import { ModalPortal } from '@/components/modal-portal';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import {
  createSupplierPaymentRequestAction,
  updateSupplierPaymentRequestAction,
} from './payment-request-actions';

export interface PaymentRequestRequisitesPrefill {
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankBik: string | null;
  bankCorrAccount: string | null;
}

/** Этап в форме (строковые поля ввода). */
export interface PaymentRequestStageRow {
  percent: string;
  plannedPayDate: string;
  comment: string;
}

/** Прежнее вложение (edit-режим). */
export interface PaymentRequestExistingFile {
  id: string;
  originalFileName: string;
  sizeBytes: number;
  fileUrl: string;
}

interface Props {
  mode: 'create' | 'edit';
  open: boolean;
  onClose: () => void;
  /** Вызывается после успешного сохранения (обычно `router.refresh`). */
  onSaved?: () => void;

  purchaseOrderId: string;
  supplierName: string;
  /** id заявки — обязателен в edit-режиме. */
  requestId?: string;

  /**
   * Список активных поставщиков для выбора плательщика (create-режим).
   * Содержит реквизиты и дефолтную статью ДДС — авто-подстановка идёт из
   * этого списка без доп. запроса. В edit-режиме можно не передавать.
   */
  suppliers?: SupplierListItemDto[];
  /** Активные статьи ДДС (казначейство) для выпадающего списка. */
  cashFlowItems: CashFlowItemDto[];
  /** Поставщик-плательщик по умолчанию (create — из заказа, edit — из заявки). */
  initialSupplierId: string;
  /** Статья ДДС по умолчанию (create — из карточки поставщика, edit — из заявки). */
  initialCashFlowItemId: string | null;
  /** Имя статьи ДДС по умолчанию — для опции, если статья уже неактивна. */
  initialCashFlowItemName?: string | null;

  /** Начальные значения (create — предзаполнение, edit — из заявки). */
  initialAmount: string | null;
  initialCurrency: string | null;
  initialComment?: string | null;
  initialRequisites: PaymentRequestRequisitesPrefill;
  initialStages?: PaymentRequestStageRow[];
  initialStatus?: string;
  existingFiles?: PaymentRequestExistingFile[];
}

const DEFAULT_STAGE: PaymentRequestStageRow = {
  percent: '100',
  plannedPayDate: '',
  comment: '',
};

function parseNum(s: string): number {
  const n = Number(String(s).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n: number, currency: string): string {
  if (!Number.isFinite(n)) return '—';
  const v = n.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const cur = !currency || currency.toUpperCase() === 'RUB' ? '₽' : currency;
  return `${v} ${cur}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export function PaymentRequestFormModal({
  mode,
  open,
  onClose,
  onSaved,
  purchaseOrderId,
  supplierName,
  requestId,
  suppliers,
  cashFlowItems,
  initialSupplierId,
  initialCashFlowItemId,
  initialCashFlowItemName,
  initialAmount,
  initialCurrency,
  initialComment,
  initialRequisites,
  initialStages,
  initialStatus,
  existingFiles,
}: Props) {
  const isEdit = mode === 'edit';
  /**
   * Поставщики, созданные «на лету» из селекта (CreatableSelect):
   * мержим их в options, чтобы `onSupplierChange` находил реквизиты
   * нового поставщика так же, как у пришедших с сервера.
   */
  const [extraSuppliers, setExtraSuppliers] = useState<SupplierListItemDto[]>(
    [],
  );
  const baseSuppliers = suppliers ?? [];
  const supplierOptions = [
    ...baseSuppliers,
    ...extraSuppliers.filter(
      (x) => !baseSuppliers.some((s) => s.id === x.id),
    ),
  ];

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('RUB');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<string>('DRAFT');
  const [supplierId, setSupplierId] = useState(initialSupplierId);
  const [cashFlowItemId, setCashFlowItemId] = useState(
    initialCashFlowItemId ?? '',
  );
  const [req, setReq] = useState<PaymentRequestRequisitesPrefill>(initialRequisites);
  const [stages, setStages] = useState<PaymentRequestStageRow[]>([DEFAULT_STAGE]);
  const [files, setFiles] = useState<File[]>([]);
  const [keptFiles, setKeptFiles] = useState<PaymentRequestExistingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Сброс состояния при открытии. Зависим только от open/requestId, чтобы
  // повторные рендеры родителя (новая identity initial*-объектов) не
  // затирали ввод пользователя.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    setAmount(initialAmount ?? '');
    setCurrency((initialCurrency ?? 'RUB') || 'RUB');
    setComment(initialComment ?? '');
    setStatus(initialStatus ?? 'DRAFT');
    setSupplierId(initialSupplierId);
    setCashFlowItemId(initialCashFlowItemId ?? '');
    setReq(initialRequisites);
    setStages(
      initialStages && initialStages.length > 0
        ? initialStages
        : [DEFAULT_STAGE],
    );
    setFiles([]);
    setKeptFiles(existingFiles ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestId]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  // Смена поставщика-плательщика (create-режим): подтягиваем реквизиты и
  // дефолтную статью ДДС прямо из переданного списка — без доп. запроса.
  const applySupplierPrefill = useCallback((s: SupplierListItemDto) => {
    setReq({
      legalName: s.legalName,
      inn: s.inn,
      kpp: s.kpp,
      bankName: s.bankName,
      bankAccount: s.bankAccount,
      bankBik: s.bankBik,
      bankCorrAccount: s.bankCorrAccount,
    });
    setCashFlowItemId(s.defaultCashFlowItemId ?? '');
  }, []);

  const onSupplierChange = useCallback(
    (nextId: string) => {
      setSupplierId(nextId);
      const s = supplierOptions.find((x) => x.id === nextId);
      if (!s) return;
      applySupplierPrefill(s);
    },
    [supplierOptions, applySupplierPrefill],
  );

  /**
   * Поставщик, созданный из селекта: на момент `onValueChange` его ещё
   * нет в `supplierOptions` (state не применился), поэтому реквизиты
   * заполняем отдельным колбэком из свежего DTO.
   */
  const onSupplierCreated = useCallback(
    (s: SupplierListItemDto) => {
      setSupplierId(s.id);
      applySupplierPrefill(s);
    },
    [applySupplierPrefill],
  );

  // Если выбранная статья ДДС не входит в активный список (например, её
  // деактивировали) — покажем её отдельной опцией, чтобы не «потерять».
  const cashFlowMissing =
    cashFlowItemId !== '' &&
    !cashFlowItems.some((i) => i.id === cashFlowItemId);
  const cashFlowMissingName =
    supplierOptions.find((s) => s.defaultCashFlowItemId === cashFlowItemId)
      ?.defaultCashFlowItemName ??
    initialCashFlowItemName ??
    'Текущая статья';

  const totalNum = parseNum(amount);
  const stageView = useMemo(
    () =>
      stages.map((s) => {
        const pct = parseNum(s.percent);
        const amt =
          Number.isFinite(totalNum) && Number.isFinite(pct)
            ? round2((totalNum * pct) / 100)
            : NaN;
        return { pct, amt };
      }),
    [stages, totalNum],
  );
  const sumPercent = stageView.reduce(
    (acc, s) => acc + (Number.isFinite(s.pct) ? s.pct : 0),
    0,
  );
  const sumStages = stageView.reduce(
    (acc, s) => acc + (Number.isFinite(s.amt) ? s.amt : 0),
    0,
  );
  const percentMismatch = Math.abs(sumPercent - 100) > 0.0001;

  const updateStage = useCallback(
    (idx: number, patch: Partial<PaymentRequestStageRow>) => {
      setStages((prev) =>
        prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
      );
    },
    [],
  );
  const addStage = useCallback(() => {
    setStages((prev) =>
      prev.length >= SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT
        ? prev
        : [...prev, { percent: '', plannedPayDate: '', comment: '' }],
    );
  }, []);
  const removeStage = useCallback((idx: number) => {
    setStages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  /** Сколько всего вложений (прежние, что оставляем + новые). */
  const totalFileCount = keptFiles.length + files.length;

  const acceptFiles = useCallback(
    (incoming: FileList | File[]) => {
      setError(null);
      const arr = Array.from(incoming);
      setFiles((prev) => {
        const next = [...prev];
        for (const f of arr) {
          if (f.size <= 0) continue;
          if (f.size > SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES) {
            const mb = Math.round(
              SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES / 1024 / 1024,
            );
            setError(`«${f.name}»: больше ${mb} МБ`);
            continue;
          }
          if (keptFiles.length + next.length >= SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT) {
            setError(`Лимит вложений: ${SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT}.`);
            break;
          }
          next.push(f);
        }
        return next;
      });
    },
    [keptFiles.length],
  );
  const removeNewFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);
  const removeKeptFile = useCallback((id: string) => {
    setKeptFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!Number.isFinite(totalNum) || totalNum <= 0) {
      setError('Укажите сумму заявки больше нуля.');
      return;
    }
    const cleanStages = stages.filter((s) => s.percent.trim() !== '');
    if (cleanStages.length === 0) {
      setError('Добавьте хотя бы один этап оплаты с процентом.');
      return;
    }
    for (const s of cleanStages) {
      const p = parseNum(s.percent);
      if (!Number.isFinite(p) || p <= 0 || p > 100) {
        setError('Процент этапа должен быть в диапазоне от 0 до 100.');
        return;
      }
    }
    // Σ процентов обязана быть 100% (бэкенд это тоже enforce-ит — блок здесь
    // ради немедленной обратной связи вместо ошибки от сервера).
    const sumPct = cleanStages.reduce((acc, s) => acc + parseNum(s.percent), 0);
    if (Math.abs(sumPct - 100) > 0.0001) {
      setError('Сумма процентов этапов должна быть равна 100%.');
      return;
    }
    if (isEdit && !requestId) {
      setError('Не удалось определить заявку для сохранения.');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        amount: amount.trim().replace(',', '.'),
        currency: currency.trim() || null,
        comment: comment.trim() || null,
        cashFlowItemId: cashFlowItemId || null,
        legalName: req.legalName ?? '',
        inn: req.inn ?? '',
        kpp: req.kpp ?? '',
        bankName: req.bankName ?? '',
        bankAccount: req.bankAccount ?? '',
        bankBik: req.bankBik ?? '',
        bankCorrAccount: req.bankCorrAccount ?? '',
        stages: cleanStages.map((s) => ({
          percent: s.percent.trim().replace(',', '.'),
          plannedPayDate:
            s.plannedPayDate.trim() === '' ? null : s.plannedPayDate,
          comment: s.comment.trim() === '' ? null : s.comment.trim(),
        })),
      };
      if (isEdit) {
        payload.status = status;
        payload.keepFileIds = keptFiles.map((f) => f.id);
      } else {
        // Плательщик (по умолчанию поставщик заказа, мог быть изменён).
        payload.supplierId = supplierId || undefined;
      }

      const fd = new FormData();
      fd.append('payload', JSON.stringify(payload));
      for (const file of files) fd.append('files', file, file.name);

      const res = isEdit
        ? await updateSupplierPaymentRequestAction(
            purchaseOrderId,
            requestId as string,
            fd,
          )
        : await createSupplierPaymentRequestAction(purchaseOrderId, fd);

      if (!res.ok) {
        setError(
          res.error ??
            (isEdit
              ? 'Не удалось сохранить заявку на оплату.'
              : 'Не удалось создать заявку на оплату.'),
        );
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onClose();
      onSaved?.();
    } catch {
      setError(
        isEdit
          ? 'Не удалось сохранить заявку на оплату.'
          : 'Не удалось создать заявку на оплату.',
      );
      setSubmitting(false);
    }
  }

  const reqField = (
    key: keyof PaymentRequestRequisitesPrefill,
    label: string,
    maxLength: number,
    placeholder?: string,
  ) => (
    <div className="spr-field">
      <label htmlFor={`spr-${key}`}>{label}</label>
      <input
        id={`spr-${key}`}
        type="text"
        maxLength={maxLength}
        value={req[key] ?? ''}
        placeholder={placeholder}
        onChange={(e) => setReq((p) => ({ ...p, [key]: e.target.value }))}
        disabled={submitting}
      />
    </div>
  );

  if (!open) return null;

  return (
    <>
      <ModalPortal>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? 'Редактировать заявку на оплату' : 'Создать заявку на оплату'}
          className="spr-overlay"
          onClick={closeModal}
        >
          <div className="spr-window" onClick={(e) => e.stopPropagation()}>
            <header className="spr-header">
              <div>
                <h2>{isEdit ? 'Редактирование заявки' : 'Заявка на оплату'}</h2>
                <span className="spr-muted">{supplierName}</span>
              </div>
              <button
                type="button"
                className="spr-icon-btn"
                onClick={closeModal}
                aria-label="Закрыть"
                disabled={submitting}
              >
                <X size={18} strokeWidth={1.7} aria-hidden />
              </button>
            </header>

            <form className="spr-form" onSubmit={onSubmit}>
              {!isEdit && supplierOptions.length > 0 && (
                <div className="spr-field">
                  <label htmlFor="spr-supplier">Поставщик (плательщик)</label>
                  <CreatableSelect
                    entity="supplier"
                    id="spr-supplier"
                    value={supplierId}
                    onValueChange={onSupplierChange}
                    disabled={submitting}
                    disableCreate={submitting}
                    modalZIndex={1100}
                    existingValues={supplierOptions.map((s) => s.id)}
                    onCreated={(created) => {
                      // Detail extends ListItem — реквизиты уже внутри.
                      setExtraSuppliers((prev) => [
                        ...prev.filter((x) => x.id !== created.id),
                        created,
                      ]);
                      onSupplierCreated(created);
                    }}
                  >
                    {supplierOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.status !== 'ACTIVE' ? ' (неактивен)' : ''}
                      </option>
                    ))}
                  </CreatableSelect>
                  <span className="spr-muted">
                    Реквизиты и статья ДДС подтягиваются из карточки
                    выбранного поставщика. По умолчанию — поставщик заказа.
                  </span>
                </div>
              )}

              <div className="spr-grid-2">
                <div className="spr-field">
                  <label htmlFor="spr-amount">Сумма заявки</label>
                  <input
                    id="spr-amount"
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={submitting}
                    style={{ textAlign: 'right' }}
                  />
                </div>
                <div className="spr-field">
                  <label htmlFor="spr-currency">Валюта</label>
                  <input
                    id="spr-currency"
                    type="text"
                    maxLength={16}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    disabled={submitting}
                  />
                </div>
              </div>

              <div className="spr-field">
                <label htmlFor="spr-dds">Статья ДДС (казначейство)</label>
                <CreatableSelect
                  entity="cashFlowItem"
                  id="spr-dds"
                  value={cashFlowItemId}
                  onValueChange={setCashFlowItemId}
                  disabled={submitting}
                  disableCreate={submitting}
                  modalZIndex={1100}
                  existingValues={cashFlowItems.map((item) => item.id)}
                >
                  <option value="">— не выбрана —</option>
                  {cashFlowMissing && (
                    <option value={cashFlowItemId}>
                      {cashFlowMissingName} (неактивна)
                    </option>
                  )}
                  {cashFlowItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.direction
                        ? ` · ${CASH_FLOW_DIRECTION_LABELS[item.direction]}`
                        : ''}
                      {item.code ? ` (${item.code})` : ''}
                    </option>
                  ))}
                </CreatableSelect>
                <span className="spr-muted">
                  По какой статье пойдёт оплата в казначействе. По умолчанию —
                  статья из карточки поставщика.
                </span>
              </div>

              {isEdit && (
                <div className="spr-field">
                  <label htmlFor="spr-status">Статус заявки</label>
                  <select
                    id="spr-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    disabled={submitting}
                  >
                    {SUPPLIER_PAYMENT_REQUEST_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {SUPPLIER_PAYMENT_REQUEST_STATUS_LABELS[
                          s as SupplierPaymentRequestStatus
                        ] ?? s}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <fieldset className="spr-fieldset">
                <legend>Реквизиты для оплаты</legend>
                <div className="spr-grid-2">
                  {reqField('legalName', 'Юр. название', 300, 'ООО «…»')}
                  {reqField('inn', 'ИНН', 32)}
                  {reqField('kpp', 'КПП', 32)}
                  {reqField('bankName', 'Банк', 300)}
                  {reqField('bankAccount', 'Расчётный счёт', 64)}
                  {reqField('bankBik', 'БИК', 32)}
                  {reqField('bankCorrAccount', 'Корр. счёт', 64)}
                </div>
              </fieldset>

              <div className="spr-field">
                <div className="spr-stages-head">
                  <label>Этапы оплаты</label>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost spr-add"
                    onClick={addStage}
                    disabled={
                      submitting ||
                      stages.length >= SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT
                    }
                  >
                    <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить этап
                  </button>
                </div>

                <div className="spr-table-wrap">
                  <table className="spr-table">
                    <thead>
                      <tr>
                        <th style={{ width: 56 }}>Этап</th>
                        <th style={{ width: 110 }}>%</th>
                        <th style={{ width: 150 }}>Сумма</th>
                        <th style={{ width: 160 }}>Дата оплаты</th>
                        <th>Комментарий</th>
                        <th style={{ width: 40 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {stages.map((s, idx) => (
                        <tr key={idx}>
                          <td>
                            <strong>{idx + 1}</strong>
                          </td>
                          <td>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={s.percent}
                              onChange={(e) =>
                                updateStage(idx, { percent: e.target.value })
                              }
                              placeholder="%"
                              disabled={submitting}
                              style={{ textAlign: 'right' }}
                            />
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {fmtMoney(stageView[idx]?.amt, currency)}
                          </td>
                          <td>
                            <input
                              type="date"
                              value={s.plannedPayDate}
                              onChange={(e) =>
                                updateStage(idx, {
                                  plannedPayDate: e.target.value,
                                })
                              }
                              disabled={submitting}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={s.comment}
                              onChange={(e) =>
                                updateStage(idx, { comment: e.target.value })
                              }
                              placeholder="например, предоплата"
                              disabled={submitting}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="spr-icon-btn"
                              onClick={() => removeStage(idx)}
                              disabled={submitting || stages.length <= 1}
                              aria-label="Удалить этап"
                            >
                              <Trash2 size={15} strokeWidth={1.6} aria-hidden />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  className={`spr-sum ${percentMismatch ? 'spr-sum--warn' : ''}`}
                >
                  <span>
                    Σ процентов: <strong>{round2(sumPercent)}%</strong>
                  </span>
                  <span>
                    Σ этапов: <strong>{fmtMoney(sumStages, currency)}</strong> из{' '}
                    {fmtMoney(totalNum, currency)}
                  </span>
                  {percentMismatch && (
                    <span className="spr-warn-text">
                      Сумма процентов не равна 100% — проверьте этапы.
                    </span>
                  )}
                </div>
              </div>

              <div className="spr-field">
                <label>Счёт / документы на оплату</label>

                {isEdit && keptFiles.length > 0 && (
                  <ul className="spr-files">
                    {keptFiles.map((f) => (
                      <li key={f.id}>
                        <Paperclip size={14} strokeWidth={1.6} aria-hidden />
                        <a
                          className="spr-file-name spr-file-link"
                          href={f.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={f.originalFileName}
                        >
                          {f.originalFileName}
                        </a>
                        <span className="spr-muted">{fmtSize(f.sizeBytes)}</span>
                        <button
                          type="button"
                          className="spr-icon-btn"
                          onClick={() => removeKeptFile(f.id)}
                          disabled={submitting}
                          aria-label="Убрать вложение"
                          title="Убрать (удалится при сохранении)"
                        >
                          <X size={14} strokeWidth={1.6} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div
                  className="spr-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer?.files) acceptFiles(e.dataTransfer.files);
                  }}
                >
                  <Upload size={20} strokeWidth={1.6} aria-hidden />
                  <span>
                    {isEdit
                      ? 'Перетащите новый документ сюда или нажмите, чтобы выбрать'
                      : 'Перетащите счёт сюда или нажмите, чтобы выбрать'}
                  </span>
                  <span className="spr-muted" style={{ fontSize: '0.8rem' }}>
                    Любой формат, до{' '}
                    {Math.round(
                      SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES / 1024 / 1024,
                    )}{' '}
                    МБ, максимум {SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT}
                    {isEdit ? ` (всего сейчас ${totalFileCount})` : ''}.
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files) acceptFiles(e.target.files);
                      e.target.value = '';
                    }}
                    disabled={submitting}
                  />
                </div>
                {files.length > 0 && (
                  <ul className="spr-files">
                    {files.map((f, idx) => (
                      <li key={`${f.name}-${idx}`}>
                        <Paperclip size={14} strokeWidth={1.6} aria-hidden />
                        <span className="spr-file-name">{f.name}</span>
                        <span className="spr-muted">{fmtSize(f.size)}</span>
                        <button
                          type="button"
                          className="spr-icon-btn"
                          onClick={() => removeNewFile(idx)}
                          disabled={submitting}
                          aria-label="Удалить файл"
                        >
                          <X size={14} strokeWidth={1.6} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="spr-field">
                <label htmlFor="spr-comment">Комментарий к заявке</label>
                <textarea
                  id="spr-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="например, оплата по договору №…"
                  disabled={submitting}
                />
              </div>

              {error && (
                <div className="spr-error" role="alert">
                  {error}
                </div>
              )}

              <footer className="spr-footer">
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={closeModal}
                  disabled={submitting}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="admin-btn admin-btn--primary"
                  disabled={submitting}
                >
                  {submitting
                    ? isEdit
                      ? 'Сохраняем…'
                      : 'Создаём…'
                    : isEdit
                      ? 'Сохранить'
                      : 'Создать заявку'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      </ModalPortal>

      <style>{`
        .spr-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(15, 23, 42, 0.45);
          display: flex; align-items: flex-start; justify-content: center;
          padding: 4vh 16px; overflow-y: auto;
        }
        .spr-window {
          background: #fff; border-radius: 10px; width: 100%; max-width: 760px;
          box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
          display: flex; flex-direction: column;
        }
        .spr-header {
          display: flex; justify-content: space-between; align-items: flex-start;
          padding: 14px 16px; border-bottom: 1px solid #e2e8f0;
        }
        .spr-header h2 { margin: 0; font-size: 1.05rem; color: #0f172a; }
        .spr-form { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
        .spr-grid-2 {
          display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
        }
        .spr-field { display: flex; flex-direction: column; gap: 4px; }
        .spr-field > label { font-size: 0.85rem; font-weight: 600; color: #1f2937; }
        .spr-field input, .spr-field textarea, .spr-field select {
          padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px;
          font-size: 0.92rem; background: #fff; width: 100%; resize: vertical;
        }
        .spr-muted { color: #64748b; font-size: 0.82rem; }
        .spr-fieldset {
          border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin: 0;
        }
        .spr-fieldset legend {
          font-size: 0.82rem; font-weight: 600; color: #1f2937; padding: 0 6px;
        }
        .spr-stages-head {
          display: flex; align-items: center; justify-content: space-between;
        }
        .spr-add { padding: 4px 10px; font-size: 0.82rem; }
        .spr-table-wrap { overflow-x: auto; margin-top: 4px; }
        .spr-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
        .spr-table th, .spr-table td {
          border: 1px solid #e2e8f0; padding: 4px 6px; text-align: left;
          vertical-align: middle;
        }
        .spr-table th { background: #f8fafc; font-size: 0.78rem; color: #475569; }
        .spr-table input {
          width: 100%; padding: 4px 6px; border: 1px solid #cbd5e1;
          border-radius: 4px; background: #fff; font-size: 0.86rem;
        }
        .spr-sum {
          display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px;
          font-size: 0.86rem; color: #334155;
        }
        .spr-sum--warn { color: #92400e; }
        .spr-warn-text { color: #b45309; font-weight: 600; }
        .spr-dropzone {
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          border: 1px dashed #cbd5e1; border-radius: 6px; padding: 14px;
          text-align: center; cursor: pointer; font-size: 0.9rem; color: #475569;
        }
        .spr-dropzone:hover { background: #f8fafc; }
        .spr-files {
          list-style: none; padding: 0; margin: 6px 0;
          display: flex; flex-direction: column; gap: 4px;
        }
        .spr-files li {
          display: flex; align-items: center; gap: 8px;
          padding: 4px 8px; border: 1px solid #e5e7eb; border-radius: 4px;
          font-size: 0.85rem;
        }
        .spr-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .spr-file-link { color: #2563eb; text-decoration: none; }
        .spr-file-link:hover { text-decoration: underline; }
        .spr-icon-btn {
          background: transparent; border: none; cursor: pointer;
          padding: 4px; border-radius: 4px; color: #475569;
        }
        .spr-icon-btn:hover:not(:disabled) { background: #f1f5f9; }
        .spr-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .spr-error {
          background: #fee2e2; color: #991b1b; border: 1px solid #fecaca;
          padding: 6px 8px; border-radius: 6px; font-size: 0.88rem;
        }
        .spr-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          border-top: 1px solid #e2e8f0; padding-top: 12px;
        }
        @media (max-width: 640px) {
          .spr-grid-2 { grid-template-columns: 1fr; }
        }
      `}</style>
    </>
  );
}
