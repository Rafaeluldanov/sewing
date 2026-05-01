'use client';

/**
 * Mobile-first scan-driven рабочее окно ВТО (`/wto`).
 *
 * Архитектура — полная копия `QcTerminal`
 * (см. `apps/web/app/qc/qc-terminal.tsx`):
 *   - одна primary-кнопка «Сканировать паспорт» открывает
 *     `QrScannerModal` (та же камера, что у швеи и ОТК);
 *   - после распознавания QR `acceptOnWtoAction` сначала «принимает»
 *     паспорт скан-сценарием (общий `POST /api/passports/:id/scan`),
 *     а уже потом тянет WTO-карточку;
 *   - в карточке оператор нажимает «Завершить ВТО» (`completeWtoAction`).
 *
 * Никаких списков, фильтров и переходов: сканировал → действие →
 * готов к следующему скану. Полный flow зафиксирован в
 * `docs/flows.md §F6` и `docs/screens.md §10`.
 *
 * Особенности по сравнению с QC:
 *   - входной скан не «открывает карточку, чтобы посмотреть», а
 *     реально пытается зачислить паспорт на ВТО — backend
 *     делает QC-gate (`PASSPORT_NOT_QC_PASSED`) и возвращает ошибку,
 *     если паспорт ещё не прошёл ОТК. Эту ошибку показываем как
 *     обычный `error-box` — карточку не открываем;
 *   - нет блока «зафиксировать брак» (это прерогатива ОТК).
 */

import { useEffect, useState, useTransition } from 'react';
import type { WtoPassportDetailDto } from '@sewing/shared/wto';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  playCutAcceptedSound,
  playOperationCompletedSound,
} from '@/app/work/feedback';
import { logoutAction } from '@/app/(auth)/logout-action';
import { Icon } from '@/components/icon';
import { WtoWorkCard } from './wto-work-card';
import { WtoCompletedRow } from './wto-completed-row';
import {
  acceptOnWtoAction,
  completeWtoAction,
  refreshWtoPassportAction,
} from './actions';

/**
 * Сколько мс ждать между авто-перепроверками: «не ушёл ли свернутый
 * паспорт на следующую операцию». Backend — источник истины
 * (`WtoService.loadDetail` → `removedFromWto`), фронт лишь поллит. 10s
 * — тот же выбор, что у `/qc` (см. `qc-terminal.tsx`).
 */
const WTO_REMOVED_POLL_INTERVAL_MS = 10_000;

interface ErrorState {
  message: string;
  requestId?: string;
}

export function WtoTerminal() {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [detail, setDetail] = useState<WtoPassportDetailDto | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const accept = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError({ message: 'Введите или отсканируйте код паспорта' });
      return;
    }
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await acceptOnWtoAction(trimmed);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      // Защита от «вернуть в окно ВТО паспорт, который уже ушёл» —
      // полный аналог поведения `/qc`. Если оператор после complete
      // снова сканирует тот же паспорт, а следующий этап его уже
      // подхватил, backend отдаёт `removedFromWto=true`. В этом
      // случае не открываем рабочую карточку, а сообщаем коротким
      // info, что паспорт ушёл дальше.
      if (res.detail.removedFromWto) {
        setDetail(null);
        setManualCode('');
        setManualOpen(false);
        setInfo('Паспорт ушёл на следующую операцию.');
        return;
      }
      // Звук «принято» — те же fail-soft хелперы, что у швеи и ОТК.
      playCutAcceptedSound();
      setDetail(res.detail);
      setManualCode('');
      setManualOpen(false);
    });
  };

  const handleScan = (decoded: string) => {
    setScannerOpen(false);
    accept(decoded);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    accept(manualCode);
  };

  const refresh = () => {
    if (!detail) return;
    const id = detail.passportId;
    startTransition(async () => {
      const res = await refreshWtoPassportAction(id);
      if (!res.ok) return;
      if (res.detail.removedFromWto) {
        setDetail(null);
        setInfo(null);
        return;
      }
      setDetail(res.detail);
    });
  };

  // Поллер для свернутой строки «ВТО завершено» — backend сам решает,
  // когда паспорт ушёл с ВТО (см. `WtoService.loadDetail`). Поллим
  // только пока отображается completed-строка; полная рабочая
  // карточка (`!wtoCompletedAt`) уже не «ждёт чужой переход».
  useEffect(() => {
    if (!detail || !detail.wtoCompletedAt) return;
    const passportId = detail.passportId;
    const timer = setInterval(() => {
      void (async () => {
        const res = await refreshWtoPassportAction(passportId);
        if (!res.ok) return;
        if (res.detail.removedFromWto) {
          setDetail((current) =>
            current && current.passportId === passportId ? null : current,
          );
          setInfo(null);
          return;
        }
        setDetail((current) =>
          current && current.passportId === passportId ? res.detail : current,
        );
      })();
    }, WTO_REMOVED_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [detail]);

  const handleComplete = () => {
    if (!detail) return;
    const passportId = detail.passportId;
    startTransition(async () => {
      const res = await completeWtoAction(passportId);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      setError(null);
      setInfo('ВТО отмечено как завершённое');
      playOperationCompletedSound();
      setDetail(res.detail);
    });
  };

  const handleScanNext = () => {
    setDetail(null);
    setError(null);
    setInfo(null);
    setScannerOpen(true);
  };

  const primaryLabel = detail
    ? 'Сканировать другой паспорт'
    : 'Сканировать паспорт';

  return (
    <div className="seamstress-work">
      <form action={logoutAction} className="qc-logout">
        <button
          type="submit"
          className="qc-logout__btn"
          aria-label="Выйти из учётной записи"
          title="Выйти"
        >
          <Icon name="logout" size={14} />
          <span style={{ marginLeft: '0.35rem' }}>Выйти</span>
        </button>
      </form>

      {detail && !detail.wtoCompletedAt && (
        <WtoWorkCard
          detail={detail}
          pending={isPending}
          onComplete={handleComplete}
          onScanNext={handleScanNext}
          onRefresh={refresh}
        />
      )}
      {/*
       * После «Завершить ВТО» (`wtoCompletedAt != null`) большая
       * рабочая карточка сворачивается в одну компактную строку:
       * паспорт ещё «висит» в окне, но без действий. Когда backend
       * скажет `removedFromWto=true` — строка исчезнет полностью.
       */}
      {detail && detail.wtoCompletedAt && <WtoCompletedRow detail={detail} />}

      <div className="scan-card scan-card--simple" aria-label="Сканировать паспорт">
        <div>
          <h2 className="scan-card__title">
            <Icon name="wto" size={22} />
            <span style={{ marginLeft: '0.45rem' }}>{primaryLabel}</span>
          </h2>
          <p className="scan-card__hint">
            Сканируйте QR паспорта — он будет принят на ВТО (если прошёл ОТК).
          </p>
        </div>

        {error && (
          <div className="error-box" role="alert">
            <div className="error-box__msg">{error.message}</div>
            {error.requestId && (
              <div className="error-box__rid">
                req: <code>{error.requestId}</code>
              </div>
            )}
          </div>
        )}
        {info && !error && (
          <div className="info-box" role="status">
            {info}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary btn-lg btn-block scan-card__primary-camera"
          onClick={() => {
            setError(null);
            setInfo(null);
            setScannerOpen(true);
          }}
          disabled={isPending}
        >
          <Icon name="scan" size={20} />
          <span style={{ marginLeft: '0.4rem' }}>
            {isPending ? 'Загрузка…' : primaryLabel}
          </span>
        </button>

        {manualOpen ? (
          <form
            onSubmit={handleManualSubmit}
            className="seamstress-start__manual"
            aria-label="Ввести код паспорта вручную"
          >
            <label
              className="scan-card__input"
              htmlFor="wto-passport-code"
            >
              <span className="scan-card__input-label">Код паспорта</span>
              <input
                id="wto-passport-code"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Например, P-20260418-0001"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="btn btn-block"
              disabled={isPending}
            >
              Принять на ВТО
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="scan-card__manual-toggle"
            onClick={() => setManualOpen(true)}
          >
            Ввести код вручную
          </button>
        )}
      </div>

      {scannerOpen && (
        <QrScannerModal
          onScan={handleScan}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
