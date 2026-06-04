'use client';

import { useRef, useState, useTransition } from 'react';
import { COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX } from '@sewing/shared/constructor-tasks';
import type { ConstructorTaskSizeRowDto } from '@sewing/shared/constructor-tasks';
import { completeTaskAction } from '../actions';

/**
 * Форма «Завершить задачу». Для каждого размера из `task.sizeRows`
 * рендерим:
 *   - отдельный `<input type="file">` с уникальным name
 *     (`file_<sizeId>`) — backend по этому префиксу матчит файлы с
 *     `payload.sizeFiles[]`;
 *   - два поля Кулирка/Кашкорсе (м пог. на изделие) — конструктор
 *     может скорректировать значения, заданные менеджером, и они
 *     попадут в номенклатуру (`PatternItemSizeParameterValue`) при
 *     приёмке.
 *
 * Файл лекала НЕобязателен: задачу можно завершить без файлов вообще
 * или приложив их к части размеров — недогруженные размеры
 * зарегистрируются как заглушки, файл догрузят позже. Принимаем
 * PDF/PLT/DXF/PLO (см. `PatternsStorageService.saveSizeFile`, валидация
 * `PATTERN_FILE_EXTENSIONS`). Если прислать другой формат — backend
 * отдаст `PATTERN_UPLOAD_INVALID`, покажем сообщение под формой.
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
            'Завершить задачу? После этого лекало уйдёт менеджеру на ' +
              'приёмку. Скорректированные значения Кулирка/Кашкорсе ' +
              'попадут в номенклатуру.',
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
        При наличии приложите файл лекала (PDF/PLT/DXF/PLO) к размерам — это
        необязательно, файл можно догрузить позже. При необходимости
        поправьте Кулирка/Кашкорсе — м пог. на одно изделие. Эти значения
        попадут в карточку номенклатуры.
      </p>

      <div className="constructor-table-wrap">
        <table className="constructor-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Размер</th>
            <th style={{ textAlign: 'left' }}>Кулирка, м пог.</th>
            <th style={{ textAlign: 'left' }}>Кашкорсе, м пог.</th>
            <th style={{ textAlign: 'left' }}>Файл (PDF/PLT/DXF/PLO)</th>
          </tr>
        </thead>
        <tbody>
          {rowsWithSize.map((row) => {
            const fieldName = `${COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX}${row.sizeId}`;
            return (
              <tr key={row.id}>
                <td data-label="Размер">
                  <strong>{row.sizeCodeSnapshot}</strong>
                </td>
                <td data-label="Кулирка, м пог.">
                  <input
                    type="text"
                    inputMode="decimal"
                    name={`kulirka_${row.sizeId}`}
                    defaultValue={row.kulirkaMeters ?? ''}
                    placeholder="м пог."
                    style={{ width: 110, padding: '4px 6px' }}
                  />
                </td>
                <td data-label="Кашкорсе, м пог.">
                  <input
                    type="text"
                    inputMode="decimal"
                    name={`kashkorse_${row.sizeId}`}
                    defaultValue={row.kashkorseMeters ?? ''}
                    placeholder="м пог."
                    style={{ width: 110, padding: '4px 6px' }}
                  />
                </td>
                <td data-label="Файл (PDF/PLT/DXF/PLO)">
                  <input
                    type="file"
                    id={`file-${row.sizeId}`}
                    name={fieldName}
                    accept=".pdf,.plt,.dxf,.plo"
                  />
                </td>
                <td style={{ display: 'none' }}>
                  <input type="hidden" name="sizeIds" value={row.sizeId} />
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>

      <button
        type="submit"
        className="constructor-btn constructor-btn--primary"
        disabled={pending}
        style={{ marginTop: 12 }}
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
