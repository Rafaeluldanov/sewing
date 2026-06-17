'use client';

/**
 * `CreatePaymentRequestDialog` — кнопка «Создать заявку на оплату» +
 * модалка внутри карточки заказа поставщику.
 *
 * Собирает:
 *   - сумму заявки (предзаполнена суммой заказа) + валюту;
 *   - реквизиты поставщика (предзаполнены из карточки, редактируемы) —
 *     в заявку уходят снимком;
 *   - этапы оплаты: процент → авто-сумма (`round(amount × % / 100, 2)`),
 *     плановая дата оплаты, комментарий. «Σ процентов = 100%» —
 *     мягкое предупреждение (сохранить можно при любом раскладе);
 *   - вложения (счёт/инвойс + доп. документы, 0..N).
 *
 * FormData (payload JSON + files) форвардится в server action одним
 * аргументом (Next 14 не принимает File[] top-level).
 */

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { Paperclip, Plus, Trash2, Upload, Wallet, X } from 'lucide-react';
import {
  SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT,
  SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES,
  SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT,
} from '@sewing/shared/supplier-payment-requests';
import { ModalPortal } from '@/components/modal-portal';
import { createSupplierPaymentRequestAction } from './payment-request-actions';

export interface PaymentRequestRequisitesPrefill {
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankBik: string | null;
  bankCorrAccount: string | null;
}

interface Props {
  purchaseOrderId: string;
  supplierName: string;
  /** Сумма заказа (Σ qty×price) — предзаполнение поля «Сумма заявки». */
  defaultAmount: string | null;
  defaultCurrency?: string | null;
  requisites: PaymentRequestRequisitesPrefill;
}

interface StageRow {
  percent: string;
  plannedPayDate: string;
  comment: string;
}

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

export function CreatePaymentRequestDialog({
  purchaseOrderId,
  supplierName,
  defaultAmount,
  defaultCurrency,
  requisites,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('RUB');
  const [comment, setComment] = useState('');
  const [req, setReq] = useState<PaymentRequestRequisitesPrefill>(requisites);
  const [stages, setStages] = useState<StageRow[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openModal = useCallback(() => {
    setError(null);
    setAmount(defaultAmount ?? '');
    setCurrency((defaultCurrency ?? 'RUB') || 'RUB');
    setComment('');
    setReq(requisites);
    // Старт с одного этапа на 100% — типичный случай «оплата целиком»;
    // менеджер меняет процент и добавляет этапы кнопкой ниже.
    setStages([{ percent: '100', plannedPayDate: '', comment: '' }]);
    setFiles([]);
    setOpen(true);
  }, [defaultAmount, defaultCurrency, requisites]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  const totalNum = parseNum(amount);
  const stageView = useMemo(
    () =>
      stages.map((s) => {
        const pct = parseNum(s.percent);
        const amt = Number.isFinite(totalNum) && Number.isFinite(pct)
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
    (idx: number, patch: Partial<StageRow>) => {
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

  const acceptFiles = useCallback((incoming: FileList | File[]) => {
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
        if (next.length >= SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT) {
          setError(`Лимит вложений: ${SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT}.`);
          break;
        }
        next.push(f);
      }
      return next;
    });
  }, []);
  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
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

    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append(
        'payload',
        JSON.stringify({
          amount: amount.trim().replace(',', '.'),
          currency: currency.trim() || null,
          comment: comment.trim() || null,
          legalName: req.legalName ?? '',
          inn: req.inn ?? '',
          kpp: req.kpp ?? '',
          bankName: req.bankName ?? '',
          bankAccount: req.bankAccount ?? '',
          bankBik: req.bankBik ?? '',
          bankCorrAccount: req.bankCorrAccount ?? '',
          stages: cleanStages.map((s) => ({
            percent: s.percent.trim().replace(',', '.'),
            plannedPayDate: s.plannedPayDate.trim() === '' ? null : s.plannedPayDate,
            comment: s.comment.trim() === '' ? null : s.comment.trim(),
          })),
        }),
      );
      for (const file of files) fd.append('files', file, file.name);

      const res = await createSupplierPaymentRequestAction(purchaseOrderId, fd);
      if (!res.ok) {
        setError(res.error ?? 'Не удалось создать заявку на оплату.');
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setSubmitting(false);
      router.refresh();
    } catch {
      setError('Не удалось создать заявку на оплату.');
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

  return (
    <>
      <button type="button" className="admin-btn admin-btn--primary" onClick={openModal}>
        <Wallet size={16} strokeWidth={1.6} aria-hidden />
        Создать заявку на оплату
      </button>

      {open && (
        <ModalPortal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Создать заявку на оплату"
            className="spr-overlay"
            onClick={closeModal}
          >
            <div className="spr-window" onClick={(e) => e.stopPropagation()}>
              <header className="spr-header">
                <div>
                  <h2>Заявка на оплату</h2>
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
                    <span>Перетащите счёт сюда или нажмите, чтобы выбрать</span>
                    <span className="spr-muted" style={{ fontSize: '0.8rem' }}>
                      Любой формат, до{' '}
                      {Math.round(
                        SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES / 1024 / 1024,
                      )}{' '}
                      МБ, максимум {SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT}.
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
                          <span className="spr-muted">
                            {(f.size / 1024).toFixed(0)} КБ
                          </span>
                          <button
                            type="button"
                            className="spr-icon-btn"
                            onClick={() => removeFile(idx)}
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
                    {submitting ? 'Создаём…' : 'Создать заявку'}
                  </button>
                </footer>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

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
        .spr-field input, .spr-field textarea {
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
          list-style: none; padding: 0; margin: 6px 0 0 0;
          display: flex; flex-direction: column; gap: 4px;
        }
        .spr-files li {
          display: flex; align-items: center; gap: 8px;
          padding: 4px 8px; border: 1px solid #e5e7eb; border-radius: 4px;
          font-size: 0.85rem;
        }
        .spr-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
