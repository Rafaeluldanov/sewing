'use client';

/**
 * Модалка «Создать размер» на карточке номенклатуры
 * (`/admin/patterns/[id]`).
 *
 * Отвечает только за создание новой записи в общем справочнике
 * `Size` (см. `prisma/schema.prisma::Size`,
 * `apps/api/src/modules/sizes/*`). К **текущей** номенклатуре размер
 * сюда **не** привязывается — для привязки нужен DXF-файл (см.
 * `PatternSizeFile.fileUrl` NOT NULL). После успешного создания
 * подсказываем менеджеру, что дальше нужно нажать «Добавить размер»
 * и загрузить DXF.
 *
 * UX-копи / контракт:
 *   - placeholder поля — `200×300×10` (см. ТЗ §«Добавить размер на
 *     странице номенклатуры»);
 *   - подсказка «общем справочнике … во всех номенклатурах и
 *     заказах» (зафиксировано smoke-тестом);
 *   - после успеха показываем success-box «Размер … создан в общем
 *     справочнике», и **не закрываем** модалку сразу — даём
 *     менеджеру создать ещё один размер либо нажать «Готово».
 *   - revalidatePath/revalidateTag в server action освежают кэши,
 *     поэтому select модалки «Добавить размер» подхватит новый
 *     размер без F5.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle, Plus, Ruler, X, XCircle } from 'lucide-react';
import { createSizeAction } from '../actions';
import { ModalPortal } from '@/components/modal-portal';
import {
  initialCreateSizeState,
  type CreateSizeState,
} from '../form-state';

interface Props {
  patternId: string;
  onClose: () => void;
  /**
   * UX-bridge с модалкой «Добавить размер»: после успешного создания
   * размера менеджер может сразу привязать его к этой номенклатуре.
   * Если родитель прокинул колбэк, в success-state рендерим кнопку
   * «Привязать к этой номенклатуре» — она закрывает CreateSizeModal
   * и открывает AddPatternSizeModal с предвыбранным размером.
   *
   * Если колбэк не передан (например, модалку дёргают из другого
   * места без AddPatternSizeModal под рукой) — кнопка не рисуется,
   * остаётся только обычное успокаивающее «нажмите Добавить размер».
   */
  onAttachCreatedSize?: (size: { id: string; code: string }) => void;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.7} aria-hidden />
      {pending ? 'Создаём…' : 'Создать'}
    </button>
  );
}

export function CreateSizeModal({
  patternId,
  onClose,
  onAttachCreatedSize,
}: Props) {
  const titleId = useId();
  const router = useRouter();
  const [state, formAction] = useFormState<CreateSizeState, FormData>(
    createSizeAction.bind(null, patternId),
    initialCreateSizeState,
  );
  const [code, setCode] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // После успешного создания размера: чистим input, вызываем
  // router.refresh() — на случай, если кеш RSC не подхватил
  // revalidatePath из server action (см. известную issue Next.js
  // #50714). Модалку НЕ закрываем — даём менеджеру создать ещё
  // один размер либо нажать «Готово».
  useEffect(() => {
    if (state.ok) {
      setCode('');
      formRef.current?.reset();
      router.refresh();
      // Возвращаем фокус в input — типовой UX для «создать ещё».
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok, state.createdSizeId]);

  // Esc / focus-trap-light: закрываем по Escape (тот же паттерн, что
  // у `AddPatternSizeModal`).
  useEffect(() => {
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <ModalPortal>
    <div
      className="admin-size-plan-modal__backdrop"
      onMouseDown={handleBackdropClick}
      data-create-size-modal="true"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="admin-size-plan-modal"
      >
        <header className="admin-size-plan-modal__header">
          <span
            className="admin-order-card__icon admin-order-card__icon--violet"
            aria-hidden
          >
            <Ruler size={18} strokeWidth={1.7} />
          </span>
          <div className="admin-size-plan-modal__titles">
            <h3 id={titleId} className="admin-size-plan-modal__title">
              Создать размер
            </h3>
            <p className="admin-size-plan-modal__subtitle">
              Размер будет создан в общем справочнике и станет доступен
              во всех номенклатурах и заказах.
            </p>
          </div>
          <button
            type="button"
            className="admin-size-plan-modal__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={18} strokeWidth={1.8} aria-hidden />
          </button>
        </header>

        <form
          ref={formRef}
          action={formAction}
          className="admin-form"
          style={{ margin: 0 }}
        >
          <div className="admin-size-plan-modal__body">
            <div className="admin-form-grid">
              <div className="admin-field">
                <label htmlFor={`create-size-code-${patternId}`}>
                  Размер
                </label>
                <input
                  id={`create-size-code-${patternId}`}
                  ref={inputRef}
                  name="code"
                  type="text"
                  placeholder="например, 200×300×10"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  maxLength={64}
                  autoFocus
                />
                <small className="admin-muted">
                  Можно вводить как «200×300×10», «200x300x10» или
                  «200*300*10» — система приведёт к единому виду.
                  Новые размеры добавляются в конец списка
                  справочника.
                </small>
              </div>
            </div>

            {state.error && (
              <div
                className="error-box"
                role="alert"
                style={{ marginTop: 12 }}
              >
                <XCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
                {state.error}
              </div>
            )}
            {state.ok && state.successMessage && (
              <div
                className="success-box"
                role="status"
                style={{ marginTop: 12 }}
              >
                <div>
                  <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
                  {state.successMessage}{' '}
                  <span className="admin-muted">
                    Чтобы привязать размер к этой номенклатуре —
                    нажмите «Добавить размер» и загрузите DXF-файл.
                  </span>
                </div>
                {onAttachCreatedSize &&
                  state.createdSizeId &&
                  state.createdSizeCode && (
                    <div style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        className="admin-btn admin-btn--primary"
                        onClick={() => {
                          if (
                            state.createdSizeId &&
                            state.createdSizeCode
                          ) {
                            onAttachCreatedSize({
                              id: state.createdSizeId,
                              code: state.createdSizeCode,
                            });
                          }
                        }}
                        data-attach-created-size="true"
                      >
                        <ArrowRight
                          size={16}
                          strokeWidth={1.7}
                          aria-hidden
                        />
                        Привязать к этой номенклатуре
                      </button>
                    </div>
                  )}
              </div>
            )}
          </div>

          <footer
            className="admin-size-plan-modal__footer"
            style={{ justifyContent: 'flex-end' }}
          >
            <div className="admin-size-plan-modal__footer-actions">
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={onClose}
              >
                Готово
              </button>
              <SubmitButton />
            </div>
          </footer>
        </form>
      </div>
    </div>
    </ModalPortal>
  );
}
