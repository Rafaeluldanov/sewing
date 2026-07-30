'use client';

/**
 * Модальная панель «Мой день» — детальная разбивка дневного итога.
 *
 * Открывается из `DailyEarningsChip` по клику на чип. Внутри:
 *   - сделочные операции (`piecework.byOperation`) — список;
 *   - окладная часть (`salary`) — сумма + время смены;
 *   - кнопка «История 30 дней» — открывает `EarningsHistoryModal`.
 *
 * Если у сотрудника тип `PIECEWORK`/`SALARY`, рисуем только один
 * соответствующий блок. Для `MIXED` — оба.
 *
 * Дизайн — поверх существующего `.qr-modal__card` (см.
 * `globals.css`), чтобы не плодить новые модал-классы. Свои стили —
 * `.my-day-panel__*`, добавлены тем же файлом.
 */

import { useState } from 'react';
import type { MeDailyDto } from '@sewing/shared/me-daily';
import { ModalPortal } from '@/components/modal-portal';
import { EarningsHistoryModal } from './earnings-history-modal';

export interface DailyEarningsPanelProps {
  data: MeDailyDto;
  onClose: () => void;
  /** Перечитать данные (вызывается после возврата из истории). */
  onReload: () => void | Promise<void>;
}

export function DailyEarningsPanel({
  data,
  onClose,
  onReload,
}: DailyEarningsPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const handleClose = () => {
    void onReload();
    onClose();
  };

  return (
    <>
      <ModalPortal>
        <div
          className="qr-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Мой день"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
          data-testid="my-day-panel"
        >
          <div className="qr-modal__card my-day-panel__card">
            <div className="qr-modal__header">
              <h3 className="qr-modal__title">
                Мой день · {formatDateRu(data.date)}
              </h3>
              <button
                type="button"
                className="qr-modal__close"
                onClick={handleClose}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>

            {data.piecework ? <PieceworkBlock data={data} /> : null}
            {data.salary ? <SalaryBlock data={data} /> : null}

            <TotalBlock data={data} />

            <button
              type="button"
              className="btn btn-block my-day-panel__history-btn"
              onClick={() => setHistoryOpen(true)}
              data-testid="my-day-open-history"
            >
              История 30 дней →
            </button>
          </div>
        </div>
      </ModalPortal>
      {historyOpen ? (
        <EarningsHistoryModal onClose={() => setHistoryOpen(false)} />
      ) : null}
    </>
  );
}

function PieceworkBlock({ data }: { data: MeDailyDto }) {
  const pw = data.piecework!;
  if (pw.byOperation.length === 0) {
    return (
      <section className="my-day-panel__section">
        <div className="my-day-panel__section-title">Сделка</div>
        <div className="my-day-panel__empty">
          Сегодня пока не было закрытых операций
        </div>
      </section>
    );
  }
  return (
    <section className="my-day-panel__section">
      <div className="my-day-panel__section-title">Сделка</div>
      <ul className="my-day-panel__op-list">
        {pw.byOperation.map((op) => (
          <li key={op.operationId} className="my-day-panel__op-row">
            <span className="my-day-panel__op-name">{op.operationName}</span>
            <span className="my-day-panel__op-qty">{op.qty} шт</span>
            <span className="my-day-panel__op-amount">
              {formatRub(op.amount)}
            </span>
          </li>
        ))}
      </ul>
      <div className="my-day-panel__op-summary">
        <span>Итого по сделке:</span>
        <span className="my-day-panel__op-summary-total">
          {pw.totalQty} шт · {formatRub(pw.totalAmount)}
        </span>
      </div>
      {pw.pendingAmount > 0 ? (
        <div className="my-day-panel__pending" data-testid="my-day-pending">
          <span aria-hidden>⏳</span>
          <span>
            Из них {formatRub(pw.pendingAmount)} ждут подтверждения упаковщиком
          </span>
        </div>
      ) : null}
    </section>
  );
}

function SalaryBlock({ data }: { data: MeDailyDto }) {
  const sal = data.salary!;
  return (
    <section className="my-day-panel__section">
      <div className="my-day-panel__section-title">Оклад</div>
      <div className="my-day-panel__shift">
        {sal.shiftOpen ? (
          <>
            <span className="my-day-panel__shift-dot" aria-hidden />
            <span>
              Смена открыта с {formatTimeRu(sal.shiftStartedAt)} ·{' '}
              {formatDuration(sal.shiftStartedAt)}
            </span>
          </>
        ) : sal.hasEntryToday ? (
          <span>Смена за сегодня закрыта</span>
        ) : (
          <span className="my-day-panel__shift-empty">
            Смена сегодня не открывалась
          </span>
        )}
      </div>
      {/*
        Месячный оклад (29.07.2026) начисляется одной строкой за месяц,
        дневной суммы у него не существует. Показывать «начислено за
        день: 0 ₽» окладнику-месячнику — прямой путь к вопросу «почему
        мне ничего не начислили», поэтому для него другая формулировка.
      */}
      {sal.rateMode === 'MONTHLY' ? (
        <div className="my-day-panel__salary-amount">
          Оклад за месяц: <strong>{formatRub(sal.monthlyAmount ?? 0)}</strong>
          {sal.salaryPerHour !== null ? (
            <span className="my-day-panel__salary-hint">
              (≈ {formatRub(sal.salaryPerHour)}/час)
            </span>
          ) : null}
        </div>
      ) : (
        <div className="my-day-panel__salary-amount">
          Начислено за день: <strong>{formatRub(sal.amount)}</strong>
          {sal.amount === 0 && sal.salaryPerHour !== null ? (
            <span className="my-day-panel__salary-hint">
              (ставка: {formatRub(sal.salaryPerHour)}/час)
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TotalBlock({ data }: { data: MeDailyDto }) {
  return (
    <div className="my-day-panel__total">
      <span className="my-day-panel__total-label">Итого за день</span>
      <span className="my-day-panel__total-value">{formatRub(data.total)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

function formatDateRu(date: string): string {
  // date is YYYY-MM-DD по Москве; парсим без сдвига часовых поясов.
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });
  return formatter.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function formatTimeRu(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(new Date(iso));
}

function formatDuration(startedAtIso: string | null): string {
  if (!startedAtIso) return '';
  const startMs = new Date(startedAtIso).getTime();
  const now = Date.now();
  if (!Number.isFinite(startMs) || now < startMs) return '';
  const minutesTotal = Math.floor((now - startMs) / 60_000);
  const h = Math.floor(minutesTotal / 60);
  const m = minutesTotal % 60;
  if (h === 0) return `${m} мин`;
  return `${h} ч ${m} мин`;
}
