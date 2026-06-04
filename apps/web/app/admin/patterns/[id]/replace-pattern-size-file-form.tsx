'use client';

/**
 * Per-row «Загрузить/Заменить» — загрузка новой версии файла лекала
 * (PDF/PLT/DXF) для уже активного размера (в т.ч. для размера-заглушки
 * без файла). Файл выбирается прямо из таблицы, форма автосабмитится
 * по `change` инпута, чтобы менеджеру не приходилось жать
 * «Загрузить» вторым кликом.
 *
 * Используем тот же `uploadPatternSizeFileAction`, что и модалка
 * «Добавить размер»: backend сам поднимает `version + 1` для
 * существующего sizeId (см. `PatternsService.uploadSizeFile`).
 */

import { useEffect, useRef, type ChangeEvent } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { PATTERN_FILE_EXTENSIONS } from '@sewing/shared/patterns';
import { uploadPatternSizeFileAction } from '../actions';
import {
  initialUploadPatternFileState,
  type UploadPatternFileState,
} from '../form-state';

interface Props {
  patternId: string;
  sizeId: string;
  /** Есть ли у размера уже загруженный файл (иначе это заглушка). */
  hasFile?: boolean;
}

function SubmitTrigger({
  inputRef,
  hasFile,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  hasFile: boolean;
}) {
  const { pending } = useFormStatus();
  const label = hasFile ? 'Заменить' : 'Загрузить';
  return (
    <>
      <button
        type="button"
        className="admin-table__action-link"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        title={
          hasFile
            ? 'Загрузить новую версию файла (PDF/PLT/DXF)'
            : 'Загрузить файл лекала (PDF/PLT/DXF)'
        }
      >
        <Upload size={14} strokeWidth={1.6} aria-hidden />
        {pending ? 'Загружаем…' : label}
      </button>
    </>
  );
}

export function ReplacePatternSizeFileForm({
  patternId,
  sizeId,
  hasFile = true,
}: Props) {
  const router = useRouter();
  const [state, formAction] = useFormState<UploadPatternFileState, FormData>(
    uploadPatternSizeFileAction.bind(null, patternId),
    initialUploadPatternFileState,
  );
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const accept = PATTERN_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',');

  // На успехе обновляем RSC. revalidatePath в action делает то же,
  // но в dev-окружении иногда нужно «толкнуть» клиента отдельно.
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (e.currentTarget.files && e.currentTarget.files.length > 0) {
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form action={formAction} ref={formRef} style={{ display: 'inline' }}>
      <input type="hidden" name="sizeId" value={sizeId} />
      <input
        ref={inputRef}
        name="file"
        type="file"
        accept={accept}
        onChange={onPick}
        style={{ display: 'none' }}
        aria-hidden
        tabIndex={-1}
      />
      <SubmitTrigger inputRef={inputRef} hasFile={hasFile} />
    </form>
  );
}
