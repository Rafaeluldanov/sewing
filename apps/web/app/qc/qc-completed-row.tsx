'use client';

/**
 * Компактная строка «Проверено ОТК» для scan-driven терминала `/qc`.
 *
 * После того как QC нажал «Проверка выполнена» в `QcWorkCard`, родитель
 * (`QcTerminal`) перестаёт показывать большую рабочую карточку и
 * рендерит вместо неё этот компонент: паспорт ещё «висит» в окне как
 * напоминание, но не занимает место и не предлагает никаких действий.
 *
 * Невидимое правило: как только backend сообщает `removedFromQc = true`
 * (паспорт ушёл на следующую операцию или стал терминальным —
 * `QcService.loadDetail`), родитель скрывает и эту строку. То есть сам
 * компонент про «исчезновение» ничего не знает — он чистый view.
 *
 * Минимальный контент по ТЗ: номер паспорта, размер, количество
 * (`qtyGood` — то, что прошло ОТК) и бейдж «Проверено ОТК». Кнопок
 * «брак»/«проверка выполнена» здесь нет — повторное взаимодействие с
 * паспортом возможно только через новый скан (тогда снова откроется
 * полный `QcWorkCard`).
 */

import type { QcPassportDetailDto } from '@sewing/shared/qc';

interface Props {
  detail: QcPassportDetailDto;
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

export function QcCompletedRow({ detail }: Props) {
  const time = formatTime(detail.qcCompletedAt);
  return (
    <section
      className="qc-done-row"
      aria-label={`Паспорт ${detail.passportNumber} проверен ОТК`}
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
        Проверено ОТК{time ? ` · ${time}` : ''}
      </span>
    </section>
  );
}
