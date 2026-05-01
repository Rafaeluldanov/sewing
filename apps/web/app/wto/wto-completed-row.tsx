'use client';

/**
 * Компактная строка «ВТО завершено» для scan-driven терминала `/wto`.
 *
 * Полный аналог `QcCompletedRow` (см. `apps/web/app/qc/qc-completed-row.tsx`),
 * только бейдж переименован. После «Завершить ВТО» в `WtoWorkCard`
 * родитель (`WtoTerminal`) скрывает большую карточку и рендерит этот
 * компонент: паспорт ещё «висит» в окне, но без действий. Когда
 * backend вернёт `removedFromWto = true` (паспорт ушёл на следующий
 * `OPERATION_SCAN` или стал терминальным — `WtoService.loadDetail`),
 * родитель скрывает и эту строку.
 */

import type { WtoPassportDetailDto } from '@sewing/shared/wto';

interface Props {
  detail: WtoPassportDetailDto;
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WtoCompletedRow({ detail }: Props) {
  const time = formatTime(detail.wtoCompletedAt);
  return (
    <section
      className="qc-done-row"
      aria-label={`Паспорт ${detail.passportNumber} прошёл ВТО`}
    >
      <div className="qc-done-row__main">
        <div className="qc-done-row__number" title={detail.passportNumber}>
          {detail.passportNumber}
        </div>
        <div className="qc-done-row__meta">
          <span className="qc-done-row__size">{detail.sizeCode}</span>
          <span className="qc-done-row__sep" aria-hidden="true">
            ·
          </span>
          <span className="qc-done-row__qty">{detail.qtyGood} шт.</span>
        </div>
      </div>
      <span className="qc-done-row__badge" role="status">
        ВТО завершено{time ? ` · ${time}` : ''}
      </span>
    </section>
  );
}
