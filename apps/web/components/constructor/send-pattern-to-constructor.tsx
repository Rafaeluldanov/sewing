'use client';

/**
 * `SendPatternToConstructorButton` — кнопка «Отправить конструктору» +
 * модалка для УЖЕ существующего лекала (`PatternItem`).
 *
 * Используется в двух местах:
 *   - карточка номенклатуры `/admin/patterns/[id]` (пункт 3 ТЗ);
 *   - карточка привязанного лекала на `/admin/orders/[id]/edit`
 *     (пункт 2 ТЗ — изделие создано через «Сохранить изделие», файла
 *     лекала ещё нет).
 *
 * В отличие от вкладки `constructor` модалки «Изделие» на
 * `/admin/orders/new`, тут НЕ создаётся новое лекало — заявка КБ
 * привязывается к переданному `patternItemId`
 * (`sendPatternToConstructorAction` → `POST /constructor-tasks/for-pattern`).
 *
 * Модалка собирает:
 *   - таблицу «Размер / Кулирка / Кашкорсе» (м пог. на изделие) —
 *     строки преднаполнены переданными размерами лекала, read-only по
 *     размеру; менеджер вводит только метраж;
 *   - комментарий конструктору;
 *   - прикреплённые документы (любой формат).
 *
 * После успешной отправки вызывает `router.refresh()` (чтобы карточка
 * заказа/номенклатуры показала новую заявку из server-data) и
 * опциональный `onDone`.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Paperclip, Send, Upload, X } from 'lucide-react';
import {
  CONSTRUCTOR_TASK_FILE_MAX_COUNT,
  CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
} from '@sewing/shared/constructor-tasks';
import { ModalPortal } from '@/components/modal-portal';
import { sendPatternToConstructorAction } from './actions';

export interface SendPatternToConstructorSize {
  sizeId: string;
  sizeCode: string;
}

interface Props {
  patternItemId: string;
  patternName: string;
  /**
   * Размеры лекала, для которых менеджер заполнит погонные метры.
   * На карточке заказа — размеры заказа; на карточке номенклатуры —
   * размеры лекала (`PatternSizeFile`/`sizeRefs`). Если пусто —
   * кнопка покажет подсказку, что размеры нужно добавить.
   */
  sizes: SendPatternToConstructorSize[];
  /** Класс для триггер-кнопки (по умолчанию ghost). */
  buttonClassName?: string;
  /** Текст триггер-кнопки. */
  buttonLabel?: string;
  /** Вызывается после успешной отправки (например, закрыть карточку). */
  onDone?: () => void;
}

interface Row {
  sizeId: string;
  sizeCode: string;
  kulirkaMeters: string;
  kashkorseMeters: string;
}

export function SendPatternToConstructorButton({
  patternItemId,
  patternName,
  sizes,
  buttonClassName = 'admin-btn admin-btn--ghost',
  buttonLabel = 'Отправить конструктору',
  onDone,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openModal = useCallback(() => {
    setError(null);
    setComment('');
    setFiles([]);
    setRows(
      sizes.map((s) => ({
        sizeId: s.sizeId,
        sizeCode: s.sizeCode,
        kulirkaMeters: '',
        kashkorseMeters: '',
      })),
    );
    setOpen(true);
  }, [sizes]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  const updateRow = useCallback(
    (sizeId: string, patch: Partial<Pick<Row, 'kulirkaMeters' | 'kashkorseMeters'>>) => {
      setRows((prev) =>
        prev.map((r) => (r.sizeId === sizeId ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const acceptFiles = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const arr = Array.from(incoming);
    setFiles((prev) => {
      const next = [...prev];
      for (const f of arr) {
        if (f.size <= 0) continue;
        if (f.size > CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES) {
          const mb = Math.round(
            CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES / 1024 / 1024,
          );
          setError(`«${f.name}»: больше ${mb} МБ`);
          continue;
        }
        if (next.length >= CONSTRUCTOR_TASK_FILE_MAX_COUNT) {
          setError(`Лимит вложений: ${CONSTRUCTOR_TASK_FILE_MAX_COUNT}.`);
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

    const cleanRows = rows.filter((r) => r.sizeId.trim() !== '');
    if (cleanRows.length === 0) {
      setError('У лекала нет размеров — добавьте размеры перед отправкой.');
      return;
    }
    const hasAnyMeters = cleanRows.some(
      (r) => r.kulirkaMeters.trim() !== '' || r.kashkorseMeters.trim() !== '',
    );
    if (!hasAnyMeters) {
      setError(
        'Заполните хотя бы одно значение Кулирки или Кашкорсе — иначе конструктору нечего считать.',
      );
      return;
    }

    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append(
        'payload',
        JSON.stringify({
          patternItemId,
          comment: comment.trim(),
          sizeRows: cleanRows.map((r) => ({
            sizeId: r.sizeId,
            sizeCodeSnapshot: r.sizeCode,
            kulirkaMeters:
              r.kulirkaMeters.trim() === ''
                ? null
                : r.kulirkaMeters.trim().replace(',', '.'),
            kashkorseMeters:
              r.kashkorseMeters.trim() === ''
                ? null
                : r.kashkorseMeters.trim().replace(',', '.'),
          })),
        }),
      );
      for (const file of files) fd.append('files', file, file.name);
      const res = await sendPatternToConstructorAction(fd);
      if (!res.ok) {
        setError(res.error ?? 'Не удалось отправить лекало конструктору');
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setSubmitting(false);
      onDone?.();
      router.refresh();
    } catch {
      setError('Не удалось отправить лекало конструктору');
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" className={buttonClassName} onClick={openModal}>
        <Send size={16} strokeWidth={1.6} aria-hidden />
        {buttonLabel}
      </button>

      {open && (
        <ModalPortal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Отправить «${patternName}» конструктору`}
            className="sptc-overlay"
            onClick={closeModal}
          >
            <div className="sptc-window" onClick={(e) => e.stopPropagation()}>
              <header className="sptc-header">
                <h2>Отправить конструктору</h2>
                <button
                  type="button"
                  className="sptc-icon-btn"
                  onClick={closeModal}
                  aria-label="Закрыть"
                  disabled={submitting}
                >
                  <X size={18} strokeWidth={1.7} aria-hidden />
                </button>
              </header>

              <form className="sptc-form" onSubmit={onSubmit}>
                <p className="sptc-muted" style={{ margin: 0 }}>
                  Лекало <strong>{patternName}</strong> уйдёт конструктору
                  на разработку. Файл лекала появится после возврата заявки.
                </p>

                <div className="sptc-field">
                  <label>Погонные метры на изделие</label>
                  <span className="sptc-muted">
                    Введите расход в погонных метрах (м пог.). Любую ячейку
                    можно оставить пустой — конструктор уточнит её при
                    разработке.
                  </span>
                  <div className="sptc-table-wrap">
                    <table className="sptc-table">
                      <thead>
                        <tr>
                          <th style={{ width: 120 }}>Размер</th>
                          <th>Кулирка, м пог.</th>
                          <th>Кашкорсе, м пог.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={3}>
                              <span className="sptc-muted">
                                У лекала нет размеров. Добавьте размеры в
                                карточке номенклатуры.
                              </span>
                            </td>
                          </tr>
                        ) : (
                          rows.map((row) => (
                            <tr key={row.sizeId}>
                              <td>
                                <strong>{row.sizeCode}</strong>
                              </td>
                              <td>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={row.kulirkaMeters}
                                  onChange={(e) =>
                                    updateRow(row.sizeId, {
                                      kulirkaMeters: e.target.value,
                                    })
                                  }
                                  placeholder="м пог."
                                  disabled={submitting}
                                  style={{ textAlign: 'right' }}
                                />
                              </td>
                              <td>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={row.kashkorseMeters}
                                  onChange={(e) =>
                                    updateRow(row.sizeId, {
                                      kashkorseMeters: e.target.value,
                                    })
                                  }
                                  placeholder="м пог."
                                  disabled={submitting}
                                  style={{ textAlign: 'right' }}
                                />
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="sptc-field">
                  <label>Документы для конструктора</label>
                  <div
                    className="sptc-dropzone"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer?.files) acceptFiles(e.dataTransfer.files);
                    }}
                  >
                    <Upload size={20} strokeWidth={1.6} aria-hidden />
                    <span>
                      Перетащите файлы сюда или нажмите, чтобы выбрать
                    </span>
                    <span className="sptc-muted" style={{ fontSize: '0.8rem' }}>
                      Любой формат, до{' '}
                      {Math.round(
                        CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES / 1024 / 1024,
                      )}{' '}
                      МБ, максимум {CONSTRUCTOR_TASK_FILE_MAX_COUNT}.
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
                    <ul className="sptc-files">
                      {files.map((f, idx) => (
                        <li key={`${f.name}-${idx}`}>
                          <Paperclip size={14} strokeWidth={1.6} aria-hidden />
                          <span className="sptc-file-name">{f.name}</span>
                          <span className="sptc-muted">
                            {(f.size / 1024).toFixed(0)} КБ
                          </span>
                          <button
                            type="button"
                            className="sptc-icon-btn"
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

                <div className="sptc-field">
                  <label htmlFor="sptc-comment">Комментарий конструктору</label>
                  <textarea
                    id="sptc-comment"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    placeholder="Например: материал кулирка 180 г/м², рисунок в приложении"
                    disabled={submitting}
                  />
                </div>

                {error && (
                  <div className="sptc-error" role="alert">
                    {error}
                  </div>
                )}

                <footer className="sptc-footer">
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
                    {submitting ? 'Отправляем…' : 'Отправить'}
                  </button>
                </footer>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      <style>{`
        .sptc-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(15, 23, 42, 0.45);
          display: flex; align-items: flex-start; justify-content: center;
          padding: 5vh 16px; overflow-y: auto;
        }
        .sptc-window {
          background: #fff; border-radius: 10px; width: 100%; max-width: 640px;
          box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
          display: flex; flex-direction: column;
        }
        .sptc-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 14px 16px; border-bottom: 1px solid #e2e8f0;
        }
        .sptc-header h2 { margin: 0; font-size: 1.05rem; color: #0f172a; }
        .sptc-form { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
        .sptc-field { display: flex; flex-direction: column; gap: 4px; }
        .sptc-field > label { font-size: 0.85rem; font-weight: 600; color: #1f2937; }
        .sptc-field textarea {
          padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px;
          font-size: 0.92rem; background: #fff; resize: vertical; width: 100%;
        }
        .sptc-muted { color: #64748b; font-size: 0.82rem; }
        .sptc-table-wrap { overflow-x: auto; margin-top: 4px; }
        .sptc-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
        .sptc-table th, .sptc-table td {
          border: 1px solid #e2e8f0; padding: 4px 6px; text-align: left;
        }
        .sptc-table input {
          width: 100%; padding: 4px 6px; border: 1px solid #cbd5e1;
          border-radius: 4px; background: #fff; font-size: 0.88rem;
        }
        .sptc-dropzone {
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          border: 1px dashed #cbd5e1; border-radius: 6px; padding: 14px;
          text-align: center; cursor: pointer; font-size: 0.9rem; color: #475569;
        }
        .sptc-dropzone:hover { background: #f8fafc; }
        .sptc-files {
          list-style: none; padding: 0; margin: 6px 0 0 0;
          display: flex; flex-direction: column; gap: 4px;
        }
        .sptc-files li {
          display: flex; align-items: center; gap: 8px;
          padding: 4px 8px; border: 1px solid #e5e7eb; border-radius: 4px;
          font-size: 0.85rem;
        }
        .sptc-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sptc-icon-btn {
          background: transparent; border: none; cursor: pointer;
          padding: 4px; border-radius: 4px; color: #475569;
        }
        .sptc-icon-btn:hover { background: #f1f5f9; }
        .sptc-error {
          background: #fee2e2; color: #991b1b; border: 1px solid #fecaca;
          padding: 6px 8px; border-radius: 6px; font-size: 0.88rem;
        }
        .sptc-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          border-top: 1px solid #e2e8f0; padding-top: 12px;
        }
      `}</style>
    </>
  );
}
