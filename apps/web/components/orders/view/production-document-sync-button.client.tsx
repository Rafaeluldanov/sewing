'use client';

/**
 * Кнопка синхронизации документа выпуска — «подтянуть то, что не подтянулось».
 *
 * Одна кнопка на два случая, потому что для человека это одно действие «покажи правду сейчас»:
 *   `build`   — документа нет: собрать его по фактам (заказы, закрытые до появления раздела);
 *   `refresh` — документ есть: пересобрать состав и себестоимость, не дожидаясь события.
 *
 * ⛔ Она НЕ проводит и НЕ подтверждает документ — таких действий у выпуска нет вовсе. Всё, что
 * она делает, — заставляет систему перечитать факты цеха прямо сейчас: обычно это происходит
 * само (на закрытии коробки и при чтении изменившегося документа), но ждать события, когда
 * смотришь на цифры, человек не должен.
 */
import { useState, useTransition } from 'react';
import { FileCheck2, RefreshCw } from 'lucide-react';

import { syncProductionDocumentAction } from './production-document-actions';

interface Props {
  orderId: string;
  /** `build` — документа ещё нет; `refresh` — документ есть и его надо пересобрать. */
  mode: 'build' | 'refresh';
  /** Второстепенное размещение (шапка карточки, строка под фактами) — без жёлтой заливки. */
  subtle?: boolean;
}

export function ProductionDocumentSyncButton({ orderId, mode, subtle }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const label = mode === 'build' ? 'Сформировать документ' : 'Обновить по фактам';
  const busy = mode === 'build' ? 'Формирую…' : 'Обновляю…';

  return (
    <div>
      <button
        type="button"
        className={
          subtle ? 'admin-btn' : 'admin-btn admin-btn--primary'
        }
        disabled={pending}
        data-testid="production-document-sync-button"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await syncProductionDocumentAction(orderId);
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {mode === 'build' ? (
          <FileCheck2 size={16} strokeWidth={1.6} aria-hidden />
        ) : (
          <RefreshCw size={16} strokeWidth={1.6} aria-hidden />
        )}
        {pending ? busy : label}
      </button>
      {error ? (
        <div className="error-box" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
