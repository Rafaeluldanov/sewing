'use client';

import { useRef, useState, useTransition } from 'react';
import { COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX } from '@sewing/shared/constructor-tasks';
import type { ConstructorTaskSizeRowDto } from '@sewing/shared/constructor-tasks';
import { completeTaskAction } from '../actions';

/**
 * Форма «Завершить задачу». Для каждого размера из `task.sizeRows`
 * рендерим отдельный `<input type="file">` с уникальным name
 * (`file_<sizeId>`) — backend по этому префиксу матчит файлы с
 * `payload.sizeFiles[]`.
 *
 * Принимаем только `.dxf` (см. `PatternsStorageService.saveSizeFile`,
 * валидация `PATTERN_DXF_EXTENSIONS`). Если конструктор попытается
 * прислать PDF/JPG — backend отдаст `PATTERN_UPLOAD_INVALID`, мы
 * покажем сообщение под формой.
 */
export function CompleteTaskForm({
  taskId,
  sizeRows,
}: {
  taskId: string;
  sizeRows: ConstructorTaskSizeRowDto[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Отфильтровываем строки без sizeId (на случай legacy данных) — там
  // всё равно нет к чему приложить файл.
  const rowsWithSize = sizeRows.filter(
    (r): r is ConstructorTaskSizeRowDto & { sizeId: string } => r.sizeId !== null,
  );

  if (rowsWithSize.length === 0) {
    return (
      <p className="constructor-actions__error" role="alert">
        У задачи нет размеров с привязкой — попросите менеджера пересоздать
        её.
      </p>
    );
  }

  return (
    <form
      ref={formRef}
      className="constructor-complete-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !window.confirm(
            'Завершить задачу? После этого лекало станет ACTIVE и доступно ' +
              'для запуска заказов в производство. Изменить файлы можно ' +
              'будет только через раздел «Лекала» в админке.',
          )
        ) {
          return;
        }
        setError(null);
        startTransition(async () => {
          const fd = new FormData(formRef.current!);
          const result = await completeTaskAction(taskId, fd);
          if (!result.ok) {
            setError(result.error ?? 'Не удалось завершить задачу');
          }
        });
      }}
    >
      <p className="constructor-complete-form__hint">
        Загрузите готовое DXF-лекало для каждого размера. По одному файлу на
        размер.
      </p>

      <div className="constructor-complete-form__rows">
        {rowsWithSize.map((row) => {
          const fieldName = `${COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX}${row.sizeId}`;
          return (
            <div key={row.id} className="constructor-complete-form__row">
              <label
                className="constructor-label"
                htmlFor={`file-${row.sizeId}`}
              >
                Размер <strong>{row.sizeCodeSnapshot}</strong>
              </label>
              <input
                type="file"
                id={`file-${row.sizeId}`}
                name={fieldName}
                accept=".dxf"
                required
              />
              <input type="hidden" name="sizeIds" value={row.sizeId} />
            </div>
          );
        })}
      </div>

      <button
        type="submit"
        className="constructor-btn constructor-btn--primary"
        disabled={pending}
      >
        {pending ? 'Завершаем…' : 'Завершить и активировать лекало'}
      </button>

      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
