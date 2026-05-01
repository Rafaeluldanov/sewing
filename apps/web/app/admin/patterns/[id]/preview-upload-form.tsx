'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Upload, XCircle } from 'lucide-react';
import { PATTERN_PREVIEW_EXTENSIONS } from '@sewing/shared/patterns';
import { uploadPatternPreviewAction } from '../actions';
import {
  initialUploadPatternFileState,
  type UploadPatternFileState,
} from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Upload size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Загружаем…' : 'Загрузить превью'}
    </button>
  );
}

/**
 * Загрузка превью карточки лекала. Backend сам валидирует
 * расширение/размер (`PatternsStorageService.savePreview`); accept
 * выставляем подсказкой для UI, но не как единственную защиту.
 */
export function PatternPreviewUploadForm({
  patternId,
}: {
  patternId: string;
}) {
  const [state, formAction] = useFormState<UploadPatternFileState, FormData>(
    uploadPatternPreviewAction.bind(null, patternId),
    initialUploadPatternFileState,
  );
  const accept = PATTERN_PREVIEW_EXTENSIONS.map((ext) => `.${ext}`).join(',');
  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field">
        <label htmlFor={`preview-${patternId}`}>Файл превью</label>
        <input
          id={`preview-${patternId}`}
          name="file"
          type="file"
          accept={accept}
          required
        />
        <small className="admin-muted">
          Допустимо: {PATTERN_PREVIEW_EXTENSIONS.join(', ')}.
        </small>
      </div>
      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}
      <div className="admin-actions-row">
        <SubmitButton />
      </div>
    </form>
  );
}
