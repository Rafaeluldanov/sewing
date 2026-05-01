'use client';

/**
 * Mobile-first scan-driven рабочее окно ОТК (`/qc`).
 *
 * Архитектура повторяет паттерн швеи на `/work` (см.
 * `apps/web/app/work/seamstress-active-panel.tsx`) и зеркалит
 * `WtoTerminal` (см. `apps/web/app/wto/wto-terminal.tsx`):
 *   - одна primary-кнопка «Сканировать паспорт» открывает
 *     `QrScannerModal` (та же камера, что у швеи);
 *   - после распознавания QR `lookupQcPassportAction` сначала
 *     «принимает» паспорт скан-сценарием (общий
 *     `POST /api/passports/:id/scan` → `passport.currentOperationId`
 *     переключается на операцию категории QC, и shopfloor-проекция
 *     двигает паспорт в bucket `QC`), а уже потом тянет QC-карточку
 *     (`GET /api/qc/passports/:id`) и показывает `QcWorkCard`;
 *   - в карточке ОТК фиксирует брак (через существующий endpoint
 *     `POST /api/qc/passports/:id/defects`) и/или нажимает
 *     «Проверка выполнена» (`POST /api/qc/passports/:id/complete` →
 *     пишет `PassportEvent(QC_PASSED)`, и shopfloor-проекция
 *     двигает паспорт в bucket `QC_DONE`).
 *
 * Никаких списков, переходов между страницами и поиска — это
 * терминал: сканировал → действие → готов к следующему скану. Полный
 * flow зафиксирован в `docs/flows.md §F5` и `docs/screens.md §5`.
 */

import { useEffect, useState, useTransition } from 'react';
import type { DefectTypeDto, QcPassportDetailDto } from '@sewing/shared/qc';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  playCutAcceptedSound,
  playOperationCompletedSound,
} from '@/app/work/feedback';
import { logoutAction } from '@/app/(auth)/logout-action';
import { Icon } from '@/components/icon';
import { QcWorkCard } from './qc-work-card';
import { QcCompletedRow } from './qc-completed-row';
import {
  completeQcAction,
  lookupQcPassportAction,
  recordDefectAction,
  refreshQcPassportAction,
} from './actions';
import { initialQcDefectState } from './form-state';

/**
 * Сколько мс ждать между авто-перепроверками: «не ушёл ли свернутый
 * паспорт на следующую операцию». Backend — источник истины
 * (`QcService.loadDetail` → `removedFromQc`), фронт лишь поллит. 10s
 * выбраны как разумный компромисс между «свежо» и «не дёргаем API
 * слишком часто на телефоне».
 */
const QC_REMOVED_POLL_INTERVAL_MS = 10_000;

interface Props {
  defectTypes: DefectTypeDto[];
}

interface ErrorState {
  message: string;
  requestId?: string;
}

export function QcTerminal({ defectTypes }: Props) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [detail, setDetail] = useState<QcPassportDetailDto | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const lookup = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError({ message: 'Введите или отсканируйте код паспорта' });
      return;
    }
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await lookupQcPassportAction(trimmed);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      // Защита от «вернуть в окно ОТК паспорт, который уже ушёл».
      // Если QC после complete пытается отсканировать тот же паспорт,
      // когда следующая операция его уже подхватила — backend отдаёт
      // `removedFromQc=true`. В этом случае не открываем рабочую
      // карточку, а сообщаем коротким info, что паспорт ушёл дальше.
      if (res.detail.removedFromQc) {
        setDetail(null);
        setManualCode('');
        setManualOpen(false);
        setInfo('Паспорт ушёл на следующую операцию.');
        return;
      }
      setDetail(res.detail);
      setManualCode('');
      setManualOpen(false);
    });
  };

  const handleScan = (decoded: string) => {
    setScannerOpen(false);
    lookup(decoded);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    lookup(manualCode);
  };

  const refresh = () => {
    if (!detail) return;
    const id = detail.passportId;
    startTransition(async () => {
      const res = await refreshQcPassportAction(id);
      if (!res.ok) return;
      // Если backend сообщает, что паспорт уже не относится к ОТК
      // (`removedFromQc`), убираем строку — паспорт ушёл дальше по
      // pipeline (см. `QcService.loadDetail`).
      if (res.detail.removedFromQc) {
        setDetail(null);
        setInfo(null);
        return;
      }
      setDetail(res.detail);
      // если refresh упал — ничего страшного, оставляем уже отрисованный
      // detail; следующий action всё равно вернёт актуальные данные.
    });
  };

  // Авто-проверка для свернутого «Проверено ОТК»: backend сам решает,
  // когда паспорт ушёл с ОТК (см. `QcService.loadDetail`). Поллим
  // только пока отображается completed-строка; полная рабочая карточка
  // (`!qcCompletedAt`) уже не «ждёт чужой переход» — у QC живой паспорт
  // под руками. Поллинг сам останавливается, когда `detail` сбросился.
  useEffect(() => {
    if (!detail || !detail.qcCompletedAt) return;
    const passportId = detail.passportId;
    const timer = setInterval(() => {
      void (async () => {
        const res = await refreshQcPassportAction(passportId);
        if (!res.ok) return;
        if (res.detail.removedFromQc) {
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
    }, QC_REMOVED_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [detail]);

  const handleDefectSubmit = (formData: FormData) => {
    if (!detail) return;
    const passportId = detail.passportId;
    startTransition(async () => {
      const res = await recordDefectAction(
        passportId,
        initialQcDefectState,
        formData,
      );
      if (res.error) {
        setError({ message: res.error });
        return;
      }
      setError(null);
      if (res.info) setInfo(res.info);
      // Звук подтверждения «зафиксировано» — те же fail-soft хелперы,
      // что на /work у швеи.
      playCutAcceptedSound();
      const refreshed = await refreshQcPassportAction(passportId);
      if (refreshed.ok) setDetail(refreshed.detail);
    });
  };

  const handleComplete = () => {
    if (!detail) return;
    const passportId = detail.passportId;
    startTransition(async () => {
      const res = await completeQcAction(passportId);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      setError(null);
      setInfo('Проверка отмечена как выполненная');
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

      {detail && !detail.qcCompletedAt && (
        <QcWorkCard
          detail={detail}
          defectTypes={defectTypes}
          pending={isPending}
          onDefectSubmit={handleDefectSubmit}
          onComplete={handleComplete}
          onScanNext={handleScanNext}
          onRefresh={refresh}
        />
      )}
      {/*
       * После «Проверка выполнена» (`qcCompletedAt != null`) большая
       * рабочая карточка сворачивается в одну компактную строку:
       * паспорт ещё «висит» в окне, но без действий. Когда backend
       * скажет `removedFromQc=true` (поллер выше или ручной refresh /
       * следующий скан) — строка исчезнет полностью.
       */}
      {detail && detail.qcCompletedAt && <QcCompletedRow detail={detail} />}

      <div className="scan-card scan-card--simple" aria-label="Сканировать паспорт">
        <div>
          <h2 className="scan-card__title">
            <Icon name="qc" size={22} />
            <span style={{ marginLeft: '0.45rem' }}>{primaryLabel}</span>
          </h2>
          <p className="scan-card__hint">
            Сканируйте QR паспорта — откроется рабочая карточка ОТК.
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
              htmlFor="qc-passport-code"
            >
              <span className="scan-card__input-label">Код паспорта</span>
              <input
                id="qc-passport-code"
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
              Найти паспорт
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
