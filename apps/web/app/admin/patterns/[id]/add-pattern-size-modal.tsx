'use client';

/**
 * Модалка «Добавить размер» для карточки номенклатуры
 * (`/admin/patterns/[id]`).
 *
 * UX-инвариант:
 *   - размер считается «добавленным» к номенклатуре через активный
 *     `PatternSizeFile`. Отдельной сущности `PatternSize` нет.
 *   - В select показываем только размеры, которых ещё **нет** в
 *     активных размерах (родитель уже передаёт сюда `availableSizes`).
 *   - Если все размеры уже добавлены — рисуем подсказку «Все размеры
 *     уже добавлены» и блокируем форму.
 *   - DXF-файл обязателен (хотя backend и сам отбьёт).
 *
 * После успешной загрузки server action делает `revalidatePath`,
 * сюда возвращается `state.ok = true`, мы:
 *   1) триггерим `router.refresh()` для подстраховки (на dev-окружении
 *      `revalidatePath` иногда не пинает текущую вкладку, см. issue
 *      Next.js #50714);
 *   2) закрываем модалку через `onClose()`.
 *
 * Никаких новых backend endpoints не вводим — используем существующий
 * `uploadPatternSizeFileAction` (см. `../actions.ts`).
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
import { CheckCircle, Plus, Ruler, X, XCircle } from 'lucide-react';
import {
  PATTERN_DXF_EXTENSIONS,
  type PatternSizeRefDto,
} from '@sewing/shared/patterns';
import { uploadPatternSizeFileAction } from '../actions';
import {
  initialUploadPatternFileState,
  type UploadPatternFileState,
} from '../form-state';

interface Props {
  patternId: string;
  /**
   * Размеры справочника, которых ещё нет в активных размерах
   * номенклатуры. Уже отсортировано по `sortOrder` родителем.
   */
  availableSizes: readonly PatternSizeRefDto[];
  /**
   * Опционально: размер, который нужно сразу выбрать в select. Это
   * UX-bridge между «Создать размер» и «Добавить размер»: после
   * успешного `createSizeAction` родительский менеджер открывает эту
   * модалку и передаёт `initialSelected` с только что созданным
   * `Size`. Если родитель ещё не успел получить свежий список из
   * `router.refresh()` (small race), мы добавляем этот размер в
   * select оптимистично — иначе менеджер увидел бы пустую
   * подсказку «Все размеры уже добавлены», хотя реально вот же он.
   */
  initialSelected?: PatternSizeRefDto | null;
  onClose: () => void;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={disabled || pending}
    >
      <Plus size={16} strokeWidth={1.7} aria-hidden />
      {pending ? 'Загружаем…' : 'Добавить'}
    </button>
  );
}

export function AddPatternSizeModal({
  patternId,
  availableSizes,
  initialSelected,
  onClose,
}: Props) {
  const titleId = useId();
  const router = useRouter();
  const [state, formAction] = useFormState<UploadPatternFileState, FormData>(
    uploadPatternSizeFileAction.bind(null, patternId),
    initialUploadPatternFileState,
  );

  // Если только что создали размер «через мост» из CreateSizeModal,
  // он может ещё не успеть приехать в `availableSizes` (пропсы
  // обновляются после `router.refresh()`). Оптимистично подмешиваем
  // его в select, чтобы менеджер мог сразу загрузить DXF.
  const effectiveSizes: readonly PatternSizeRefDto[] =
    initialSelected &&
    !availableSizes.some((s) => s.id === initialSelected.id)
      ? [...availableSizes, initialSelected].sort(
          (a, b) => a.sortOrder - b.sortOrder,
        )
      : availableSizes;

  const [sizeId, setSizeId] = useState<string>(
    initialSelected?.id ?? effectiveSizes[0]?.id ?? '',
  );
  const accept = PATTERN_DXF_EXTENSIONS.map((ext) => `.${ext}`).join(',');

  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Если родитель прислал свежий список (после успешной загрузки),
  // и текущий sizeId стал недоступен — переключаемся на первый.
  useEffect(() => {
    if (
      sizeId &&
      !effectiveSizes.some((s) => s.id === sizeId)
    ) {
      setSizeId(effectiveSizes[0]?.id ?? '');
    }
  }, [effectiveSizes, sizeId]);

  // Esc / focus-trap-light: закрываем по Escape.
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

  // Закрываем модалку после успешной загрузки. Параллельно зовём
  // router.refresh() — `revalidatePath` в server action освежает кеш,
  // но клиент в некоторых сценариях продолжает крутить старый RSC,
  // поэтому подстраховываемся.
  useEffect(() => {
    if (state.ok) {
      router.refresh();
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const allAdded = effectiveSizes.length === 0;

  return (
    <div
      className="admin-size-plan-modal__backdrop"
      onMouseDown={handleBackdropClick}
      data-add-pattern-size-modal="true"
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
              Добавить размер
            </h3>
            <p className="admin-size-plan-modal__subtitle">
              Размер будет добавлен к этой номенклатуре. После этого
              он появится в погонных метрах, площадях материалов и
              заказах. Для добавления загрузите файл лекала (DXF).
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

        <form action={formAction} className="admin-form" style={{ margin: 0 }}>
          <div className="admin-size-plan-modal__body">
            {allAdded ? (
              <p className="admin-muted" style={{ margin: 0 }}>
                Все размеры уже добавлены.
              </p>
            ) : (
              <div className="admin-form-grid">
                <div className="admin-field">
                  <label htmlFor={`add-size-${patternId}`}>Размер</label>
                  <select
                    id={`add-size-${patternId}`}
                    name="sizeId"
                    value={sizeId}
                    onChange={(e) => setSizeId(e.target.value)}
                    required
                  >
                    {effectiveSizes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="admin-field">
                  <label htmlFor={`add-dxf-${patternId}`}>DXF-файл</label>
                  <input
                    id={`add-dxf-${patternId}`}
                    name="file"
                    type="file"
                    accept={accept}
                    required
                  />
                  <small className="admin-muted">
                    Допустимо только .{PATTERN_DXF_EXTENSIONS[0]}.
                  </small>
                </div>
              </div>
            )}

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
                <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
                {state.successMessage}
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
                Отмена
              </button>
              <SubmitButton disabled={allAdded} />
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}
