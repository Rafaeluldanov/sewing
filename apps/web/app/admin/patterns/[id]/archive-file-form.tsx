'use client';

import { useFormStatus } from 'react-dom';
import { Archive } from 'lucide-react';
import { archivePatternSizeFileAction } from '../actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-table__action-link"
      disabled={pending}
      title="Архивировать (файл с диска не удаляется)"
    >
      <Archive size={14} strokeWidth={1.6} aria-hidden />
      {pending ? '…' : 'Архивировать'}
    </button>
  );
}

interface Props {
  patternId: string;
  sizeId: string;
  fileId: string;
}

/**
 * Маленькая форма-кнопка «Архивировать DXF». На MVP физический
 * файл с диска не удаляем — менеджер видит запись со статусом
 * `ARCHIVED` в таблице, что считаем достаточным «soft-delete».
 */
export function ArchivePatternSizeFileForm({
  patternId,
  sizeId,
  fileId,
}: Props) {
  // Bind все три аргумента server action — он не возвращает state,
  // только мутирует и инвалидирует кеш страницы.
  const action = archivePatternSizeFileAction.bind(
    null,
    patternId,
    sizeId,
    fileId,
  );
  return (
    <form action={action} style={{ display: 'inline' }}>
      <SubmitButton />
    </form>
  );
}
