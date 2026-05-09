'use client';

/**
 * Shelf-placement flow для CUTTER_ASSISTANT на /work.
 *
 * Сценарий (`docs/flows.md §F3b`, ТЗ §5):
 *   1. Помощник нажимает «Разместить на стеллаж» → открывается камера
 *      (`QrScannerModal`) для скана ячейки.
 *   2. После скана QR ячейки делаем `lookupCellByCodeAction` →
 *      показываем confirm-модалку с кодом и срезом содержимого.
 *   3. После «Подтвердить ячейку» переходим в session-режим
 *      «Сканируйте паспорта в ячейку X»: открываем тот же
 *      `QrScannerModal`, но уже под паспорта.
 *   4. Каждый успешный скан паспорта → `placePassportToCellAction`,
 *      success/error отрисовываются inline, режим остаётся активным.
 *   5. Кнопка «Готово» завершает session-режим и возвращает помощника
 *      к выбору действия на /work.
 *
 * Источник истины — backend (`/api/cells/by-code`,
 * `/api/passports/by-code`, `/api/passports/:id/place`). Ошибка
 * размещения одного паспорта НЕ ломает session: режим остаётся
 * активным, чтобы помощник мог сразу попробовать следующий паспорт
 * или пересканировать тот же.
 */

import { useState, useTransition } from 'react';
import { ModalPortal } from '@/components/modal-portal';
import { QrScannerModal } from './qr-scanner-modal';
import {
  lookupCellByCodeAction,
  placePassportToCellAction,
  type ShelfCellLite,
  type ShelfPlacedPassport,
} from './shelf-placement-actions';
import { playCutAcceptedSound, triggerScanHaptic } from './feedback';

type Stage =
  // ничего не делаем — на /work видны две кнопки роли
  | { kind: 'idle' }
  // открыта камера для скана ячейки
  | { kind: 'scanning-cell' }
  // показываем confirm-модалку по найденной ячейке
  | { kind: 'confirm-cell'; cell: ShelfCellLite }
  // session-режим: показываем «Сканируйте паспорта в ячейку X»
  | { kind: 'placing'; cell: ShelfCellLite; scannerOpen: boolean };

/**
 * Структурированная ошибка для shelf-placement UI. Заголовок — крупный
 * read-out для оператора, подсказка (`hint`) — мелким курсивом снизу.
 * На /work оператор за секунду должен понять «что я сделал не так и
 * что делать дальше», поэтому общий API-message заворачиваем в
 * двухстрочный формат для известных кодов.
 */
interface PlacementError {
  title: string;
  hint?: string;
  requestId?: string;
}

/**
 * Маппинг ответов `placePassportToCellAction` в дружелюбное
 * двухстрочное сообщение. Бизнес-семантику кодов не меняем — просто
 * подменяем тех-message на формулировку, понятную помощнику без
 * чтения `docs/api.md`. Неизвестные коды показываем как было — лучше
 * технический текст, чем тишина.
 */
function mapPlacementError(res: {
  error: string;
  errorCode?: string;
  placedInCellCode?: string;
  errorRequestId?: string;
}): PlacementError {
  if (res.errorCode === 'PASSPORT_ALREADY_PLACED') {
    const where = res.placedInCellCode ?? '—';
    return {
      title: `Паспорт уже размещён в ячейке ${where}`,
      hint: 'Перемещение между ячейками пока недоступно',
      requestId: res.errorRequestId,
    };
  }
  return { title: res.error, requestId: res.errorRequestId };
}

export function ShelfPlacementPanel({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'scanning-cell' });
  const [error, setError] = useState<PlacementError | null>(null);
  // Лента последних успешно размещённых паспортов (новые сверху).
  // Ограничена 5 элементами, чтобы не превратить экран в журнал.
  const [recent, setRecent] = useState<ShelfPlacedPassport[]>([]);
  const [isPending, startTransition] = useTransition();

  function resetError() {
    setError(null);
  }

  function handleCellScan(decoded: string) {
    resetError();
    startTransition(async () => {
      const res = await lookupCellByCodeAction(decoded);
      if (!res.ok) {
        setError({ title: res.error, requestId: res.errorRequestId });
        setStage({ kind: 'idle' });
        return;
      }
      setStage({ kind: 'confirm-cell', cell: res.cell });
    });
  }

  function handleConfirmCell() {
    if (stage.kind !== 'confirm-cell') return;
    const cell = stage.cell;
    resetError();
    setRecent([]);
    setStage({ kind: 'placing', cell, scannerOpen: true });
  }

  function handlePassportScan(decoded: string) {
    if (stage.kind !== 'placing') return;
    const cell = stage.cell;
    // Сразу прячем сканер, чтобы success-feedback был виден; повторно
    // открыть его помощник может одной крупной кнопкой ниже.
    setStage({ kind: 'placing', cell, scannerOpen: false });
    resetError();

    // UX-guard: оператор по привычке снова навёл камеру на QR ячейки.
    // Backend в таком случае ответит общим `PASSPORT_NOT_FOUND`
    // (см. `docs/flows.md §F3b`), что вводит в заблуждение. Ловим
    // префикс `cell:` (ADR-0008) до запроса и подсказываем явно,
    // что именно нужно отсканировать. Бизнес-логику не дублируем —
    // просто сокращаем тупиковый раунд-трип.
    const trimmed = decoded.trim();
    if (trimmed.startsWith('cell:')) {
      setError({
        title: 'Сейчас нужен QR паспорта, а не ячейки',
        hint: `Ячейка ${cell.code} уже подтверждена — сканируйте паспорта.`,
      });
      return;
    }

    startTransition(async () => {
      const res = await placePassportToCellAction(cell.id, cell.code, decoded);
      if (!res.ok) {
        setError(mapPlacementError(res));
        return;
      }
      playCutAcceptedSound();
      triggerScanHaptic();
      setRecent((prev) => [res.passport, ...prev].slice(0, 5));
    });
  }

  function handleCancelConfirm() {
    if (isPending) return;
    setStage({ kind: 'idle' });
    resetError();
    onClose();
  }

  function handleStopPlacement() {
    if (isPending) return;
    setStage({ kind: 'idle' });
    resetError();
    onClose();
  }

  // -------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------

  if (stage.kind === 'idle') {
    return null;
  }

  if (stage.kind === 'scanning-cell') {
    return (
      <QrScannerModal
        onScan={handleCellScan}
        onClose={() => {
          setStage({ kind: 'idle' });
          onClose();
        }}
      />
    );
  }

  if (stage.kind === 'confirm-cell') {
    const { cell } = stage;
    const occupied = cell.contents.filter((c) => c.quantity > 0);
    return (
      <ModalPortal>
      <div
        className="qr-modal passport-confirm"
        role="dialog"
        aria-modal="true"
        aria-label="Подтвердите ячейку стеллажа"
        onClick={(e) => {
          if (e.target === e.currentTarget && !isPending) handleCancelConfirm();
        }}
      >
        <div className="qr-modal__card passport-confirm__card">
          <div className="qr-modal__header">
            <h3 className="qr-modal__title">Ячейка стеллажа</h3>
            <button
              type="button"
              className="qr-modal__close"
              onClick={handleCancelConfirm}
              aria-label="Закрыть"
              disabled={isPending}
            >
              ×
            </button>
          </div>

          <div className="passport-confirm__number">
            <span className="passport-confirm__number-label">Ячейка</span>
            <span className="passport-confirm__number-value">{cell.code}</span>
          </div>

          <dl className="passport-confirm__grid">
            <div>
              <dt>QR</dt>
              <dd className="shelf-cell__qr">{cell.qrCode}</dd>
            </div>
            <div>
              <dt>Содержимое</dt>
              <dd>
                {occupied.length === 0
                  ? 'пусто'
                  : occupied
                      .map((c) => `${c.sizeCode}×${c.quantity}`)
                      .join(', ')}
              </dd>
            </div>
          </dl>

          <div className="passport-confirm__actions">
            <button
              type="button"
              className="btn btn-block"
              onClick={handleCancelConfirm}
              disabled={isPending}
            >
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={handleConfirmCell}
              disabled={isPending}
            >
              Подтвердить ячейку
            </button>
          </div>
        </div>
      </div>
      </ModalPortal>
    );
  }

  // stage.kind === 'placing'
  const { cell } = stage;
  return (
    <div className="seamstress-work shelf-placement">
      <div className="scan-card scan-card--simple" aria-label="Размещение в ячейку">
        <div>
          <span className="shelf-placement__cell-label">Ячейка</span>
          <h2 className="scan-card__title shelf-placement__cell-code">
            {cell.code}
          </h2>
          {/* Явный read-out режима. Логи пилота показали, что после
              confirm-cell оператор по привычке снова сканирует QR
              ячейки — поэтому крупно подсказываем «теперь паспорта»
              и явно гасим сценарий с QR ячейки. */}
          <div className="shelf-placement__mode-banner" role="status">
            <strong className="shelf-placement__mode-title">
              Сканируйте паспорта
            </strong>
            <span className="shelf-placement__mode-sub">
              QR ячейки больше сканировать не нужно
            </span>
          </div>
        </div>

        {error && (
          <div className="error-box" role="alert">
            <div className="error-box__msg">{error.title}</div>
            {error.hint && (
              <div className="error-box__hint">{error.hint}</div>
            )}
            {error.requestId && (
              <div className="error-box__rid">
                req: <code>{error.requestId}</code>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary btn-lg btn-block scan-card__primary-camera"
          onClick={() => {
            resetError();
            setStage({ kind: 'placing', cell, scannerOpen: true });
          }}
          disabled={isPending}
        >
          {isPending ? 'Размещаем…' : 'Сканировать паспорт'}
        </button>

        <button
          type="button"
          className="btn btn-block btn-lg scan-card__secondary-camera"
          onClick={handleStopPlacement}
          disabled={isPending}
        >
          Готово
        </button>
      </div>

      {recent.length > 0 && (
        <div className="card shelf-placement__recent" aria-live="polite">
          <h3 className="shelf-placement__recent-title">Размещено</h3>
          <ul className="shelf-placement__recent-list">
            {recent.map((p) => (
              <li key={p.id} className="shelf-placement__recent-item">
                <div>
                  <strong>{p.number}</strong>
                  <span className="shelf-placement__recent-meta">
                    {p.productName} · {p.color} · {p.sizeCode}
                  </span>
                </div>
                <span className="shelf-placement__recent-qty">
                  {p.qtyCut} шт
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stage.scannerOpen && (
        <QrScannerModal
          onScan={handlePassportScan}
          onClose={() =>
            setStage({ kind: 'placing', cell, scannerOpen: false })
          }
        />
      )}
    </div>
  );
}
