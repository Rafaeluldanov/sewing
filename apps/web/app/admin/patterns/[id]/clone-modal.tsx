'use client';

/**
 * Модалка «Клонировать номенклатуру» на карточке лекала
 * (`/admin/patterns/[id]`). Этап «Создать номенклатуру по готовому
 * лекалу» — см. ТЗ.
 *
 * Что делает: предлагает менеджеру создать новую номенклатуру по
 * содержимому текущей. Поля `name` и `article` предзаполнены
 * (`{name} (копия)` и первый свободный `{article}-N`), но
 * редактируемы. Action `clonePatternAction` вызывает backend и при
 * успехе делает `redirect()` на новую карточку.
 *
 * Что бэкенд копирует:
 *   - активные DXF (`PatternSizeFile`) — физически в новую папку;
 *   - площади материалов (`PatternMaterialArea`);
 *   - нормы фурнитуры (`PatternItemParameterNorm`);
 *   - погонные метры (`PatternItemSizeParameterValue`);
 *   - категорию, описание.
 * Что НЕ копируется:
 *   - превью изображения (менеджер загрузит своё);
 *   - связанная задача КБ (`ConstructorTask`, она 1:1 с исходным
 *     pattern).
 *
 * Открывается из:
 *   - кнопки «Клонировать» в header карточки `/admin/patterns/[id]`
 *     (см. `clone-button.tsx`);
 *   - кнопки «Создать ещё одну номенклатуру по этому лекалу» на
 *     `/admin/constructor-tasks/[id]` (через query-param `?clone=1` —
 *     см. ТЗ).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type MouseEvent,
} from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Copy, X, XCircle } from 'lucide-react';
import { ModalPortal } from '@/components/modal-portal';
import { clonePatternAction } from '../actions';
import {
  initialClonePatternState,
  type ClonePatternState,
} from '../form-state';

interface Props {
  patternId: string;
  /** Имя текущей номенклатуры — для placeholder/предзаполнения. */
  suggestedName: string;
  /** Автогенерированный артикул (`{article}-N`) для placeholder. */
  suggestedArticle: string;
  onClose: () => void;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Copy size={16} strokeWidth={1.7} aria-hidden />
      {pending ? 'Клонируем…' : 'Создать номенклатуру'}
    </button>
  );
}

export function ClonePatternModal({
  patternId,
  suggestedName,
  suggestedArticle,
  onClose,
}: Props) {
  const titleId = useId();
  const [state, formAction] = useFormState<ClonePatternState, FormData>(
    clonePatternAction.bind(null, patternId),
    initialClonePatternState,
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);

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
        data-clone-pattern-modal="true"
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
              <Copy size={18} strokeWidth={1.7} />
            </span>
            <div className="admin-size-plan-modal__titles">
              <h3 id={titleId} className="admin-size-plan-modal__title">
                Клонировать номенклатуру
              </h3>
              <p className="admin-size-plan-modal__subtitle">
                Скопируем DXF, размеры, категорию, площади материалов,
                погонные метры и нормы фурнитуры. Превью и связанная
                задача КБ не копируются.
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
              <div className="admin-form-grid">
                <div className="admin-field">
                  <label htmlFor={`clone-name-${patternId}`}>Название</label>
                  <input
                    id={`clone-name-${patternId}`}
                    name="name"
                    type="text"
                    defaultValue={suggestedName}
                    maxLength={200}
                    autoFocus
                  />
                  <small className="admin-muted">
                    Оставьте как есть или дайте новой номенклатуре своё имя.
                  </small>
                </div>
                <div className="admin-field">
                  <label htmlFor={`clone-article-${patternId}`}>Артикул</label>
                  <input
                    id={`clone-article-${patternId}`}
                    name="article"
                    type="text"
                    defaultValue={suggestedArticle}
                    maxLength={64}
                  />
                  <small className="admin-muted">
                    Уникален в каталоге — если оставите занятый, система
                    предложит подобрать другой.
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
                <SubmitButton />
              </div>
            </footer>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}
