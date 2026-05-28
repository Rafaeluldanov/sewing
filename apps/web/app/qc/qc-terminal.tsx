'use client';

/**
 * Mobile-first scan-driven рабочее окно ОТК (`/qc`).
 *
 * Архитектура повторяет паттерн швеи на `/work` (см.
 * `apps/web/app/work/seamstress-active-panel.tsx`) и зеркалит
 * `WtoTerminal` (см. `apps/web/app/wto/wto-terminal.tsx`).
 *
 * Состояния (по аналогии с `apps/web/app/packing/packing-terminal.tsx`):
 *   1. **Нет активной смены** → рендерим reuse-форму
 *      `SeamstressShiftStart`: тот же mobile-first scan-flow «QR
 *      оборудования → выбор разрешённой операции → подтверждение»
 *      (ADR-0017, источник истины — `EquipmentOperation`). Для ОТК
 *      это типично рабочее место `qc-station-01` с allow-листом из
 *      одной операции `QC` (см. `prisma/seed.ts`).
 *   2. **Смена активна, но не на категории `QC`** (например, ОТК
 *      открыл смену не на том станке) → банер с подсказкой завершить
 *      смену через меню в правом верхнем углу. Сканирование паспортов
 *      из такой смены backend всё равно не пропустит дальше: QC
 *      endpoints доступны по RBAC, но `passports/:id/scan` подсадит
 *      паспорт в чужой `currentOperationId`, поэтому вход в работу
 *      скан-режимом — только из смены с операцией категории `QC`.
 *   3. **Смена активна, категория `QC`** → штатный сценарий:
 *      одна primary-кнопка «Сканировать паспорт» открывает
 *      `QrScannerModal` (та же камера, что у швеи); после распознавания
 *      QR `lookupQcPassportAction` сначала «принимает» паспорт
 *      скан-сценарием (общий `POST /api/passports/:id/scan` →
 *      `passport.currentOperationId` переключается на операцию
 *      категории QC, и shopfloor-проекция двигает паспорт в bucket
 *      `QC`), а уже потом тянет QC-карточку
 *      (`GET /api/qc/passports/:id`) и показывает `QcWorkCard`. В
 *      карточке ОТК фиксирует брак (через существующий endpoint
 *      `POST /api/qc/passports/:id/defects`) и/или нажимает
 *      «Проверка выполнена» (`POST /api/qc/passports/:id/complete` →
 *      пишет `PassportEvent(QC_PASSED)`, и shopfloor-проекция
 *      двигает паспорт в bucket `QC_DONE`).
 *
 * Никаких списков, переходов между страницами и поиска — это
 * терминал: открыл смену → сканировал → действие → готов к
 * следующему скану. Полный flow зафиксирован в `docs/flows.md §F5`
 * и `docs/screens.md §5`.
 */

import { useEffect, useState, useTransition } from 'react';
import type {
  DefectTypeDto,
  QcIncomingReworkDto,
  QcPassportDetailDto,
} from '@sewing/shared/qc';
import type {
  EmployeeLiteDto,
  ShiftMetaDto,
  ShiftSessionDto,
} from '@sewing/shared/shifts';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  playCutAcceptedSound,
  playOperationCompletedSound,
} from '@/app/work/feedback';
import { SeamstressShiftStart } from '@/app/work/seamstress-shift-start';
import { SeamstressActionsMenu } from '@/app/work/seamstress-actions-menu';
import { Icon } from '@/components/icon';
import { QcWorkCard } from './qc-work-card';
import {
  completeQcAction,
  lookupQcPassportAction,
  recordDefectAction,
  refreshQcPassportAction,
  returnToReworkAction,
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
  meta: ShiftMetaDto;
  employee: EmployeeLiteDto;
  /**
   * Активная смена сотрудника на момент SSR (`null`, если её нет).
   * Источник истины — `GET /shifts/current`. Терминал использует это
   * как первичный сигнал «показывать start-shift форму или scan-flow».
   */
  initialShift: ShiftSessionDto | null;
  /**
   * Категория операции активной смены. Если `null` — смены нет. Если
   * не `'QC'` — ОТК открыл смену не на том рабочем месте; показываем
   * банер и предлагаем завершить смену через меню.
   */
  activeOperationCategory: string | null;
  /**
   * Паспорты, которые мастер вернул на эту ОТК-операцию через
   * backward `set-route-step` и ждут повторной проверки. SSR-список
   * из `GET /api/qc/incoming-reworks`; терминал рисует баннер над
   * сканер-картой, чтобы ОТК сразу видел: «нужно отсканировать
   * вернувшийся паспорт». См. `QcService.listIncomingReworks`.
   */
  incomingReworks: QcIncomingReworkDto[];
}

interface ErrorState {
  message: string;
  requestId?: string;
}

export function QcTerminal({
  defectTypes,
  meta,
  employee,
  initialShift,
  activeOperationCategory,
  incomingReworks,
}: Props) {
  const isShiftActive = !!(initialShift && initialShift.active);
  const onQcShift = isShiftActive && activeOperationCategory === 'QC';

  // `SeamstressActionsMenu` нужен во всех ветках: на `/qc` для роли QC
  // глобальный `<AppHeader>` скрыт (см. `components/app-header.tsx`,
  // `isSingleWorkspaceRole`), поэтому «Завершить смену» / «Выйти» живут
  // только в этом три-точечном меню.
  return (
    <div className="seamstress-work">
      <SeamstressActionsMenu shiftActive={isShiftActive} />
      {!isShiftActive ? (
        <SeamstressShiftStart meta={meta} employee={employee} />
      ) : !onQcShift ? (
        <WrongOperationCard operationName={initialShift!.operationName} />
      ) : (
        <QcScanTerminal
          defectTypes={defectTypes}
          incomingReworks={incomingReworks}
        />
      )}
    </div>
  );
}

function WrongOperationCard({ operationName }: { operationName: string }) {
  return (
    <div
      className="scan-card scan-card--simple"
      aria-label="Смена не на ОТК"
    >
      <h2 className="scan-card__title">
        <Icon name="warning" size={22} />
        <span style={{ marginLeft: '0.45rem' }}>Смена не на ОТК</span>
      </h2>
      <p className="scan-card__hint">
        Текущая операция — <strong>{operationName}</strong>. Чтобы
        принимать паспорты на ОТК, завершите смену через меню в правом
        верхнем углу и начните новую на рабочем месте ОТК.
      </p>
    </div>
  );
}

interface ScanTerminalProps {
  defectTypes: DefectTypeDto[];
  incomingReworks: QcIncomingReworkDto[];
}

/**
 * Внутренний компонент: «штатный» scan-flow ОТК после старта смены на
 * операции категории `QC`. Логика и пользовательский опыт остались
 * как раньше — изменилась только обвязка в `QcTerminal` (start-shift
 * gate сверху, см. JSDoc файла).
 */
function QcScanTerminal({ defectTypes, incomingReworks }: ScanTerminalProps) {
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

  const handleReturnToRework = (targetOperationId: string) => {
    if (!detail) return;
    const passportId = detail.passportId;
    // Имя/операция для тоста — из выбранного eligible-target'а.
    // `currentEmployeeName` использовать НЕЛЬЗЯ: после QC-скана это
    // имя самой ОТК-оператора (инцидент 26.05.2026).
    const target = detail.eligibleReworkTargets.find(
      (t) => t.operationId === targetOperationId,
    );
    const targetEmployeeName = target?.finisherEmployeeName ?? 'швее';
    const targetOperationName = target?.operationName ?? '';
    // Confirm-диалог теперь показывается внутри ReworkPicker — здесь
    // уже подтверждённый запуск экшена.
    startTransition(async () => {
      const res = await returnToReworkAction(passportId, targetOperationId);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      setError(null);
      setInfo(
        `Возврат отправлен: ${targetEmployeeName}` +
          (targetOperationName ? ` · ${targetOperationName}` : ''),
      );
      playOperationCompletedSound();
      setDetail(null);
    });
  };

  const handleScanNext = () => {
    setDetail(null);
    setError(null);
    setInfo(null);
    setScannerOpen(true);
  };

  // Logout/«Завершить смену» теперь в общем `SeamstressActionsMenu`
  // на уровне `QcTerminal`. Внутренний scan-terminal больше не
  // дублирует logout-форму, иначе на экране висели бы две точки
  // выхода (в углу и в три-точечном меню).
  return (
    <>
      {/*
       * Пока паспорт открыт (`detail`) — большая рабочая карточка ОТК
       * с закреплённой снизу панелью действий. Она остаётся видимой и
       * ПОСЛЕ «Проверка выполнена» (бейдж + кнопка «Сканировать другой
       * паспорт» в той же закреплённой панели). Карточка исчезает
       * только когда `detail` сбрасывается в null: backend отдал
       * `removedFromQc=true` (поллер ниже / refresh) либо ОТК нажал
       * «Сканировать другой паспорт» (`handleScanNext`).
       */}
      {detail && (
        <QcWorkCard
          detail={detail}
          defectTypes={defectTypes}
          pending={isPending}
          error={error}
          info={info}
          onDefectSubmit={handleDefectSubmit}
          onComplete={handleComplete}
          onReturnToRework={handleReturnToRework}
          onScanNext={handleScanNext}
          onRefresh={refresh}
        />
      )}

      {!detail && incomingReworks.length > 0 && (
        <IncomingReworksBanner items={incomingReworks} />
      )}

      {!detail && (
        <div className="scan-card scan-card--simple" aria-label="Сканировать паспорт">
          <div>
            <h2 className="scan-card__title">
              <Icon name="qc" size={22} />
              <span style={{ marginLeft: '0.45rem' }}>Сканировать паспорт</span>
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
              {isPending ? 'Загрузка…' : 'Сканировать паспорт'}
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
      )}

      {scannerOpen && (
        <QrScannerModal
          onScan={handleScan}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Баннер «возвращены на повторную проверку» над сканер-картой.
 *
 * Источник — `QcService.listIncomingReworks`: паспорты, что мастер
 * вернул на эту ОТК-операцию через backward `set-route-step`. Цель —
 * чтобы ОТК увидел возврат сразу, ещё до того как соберётся
 * сканировать. После скана `lookupQcPassportAction` откроет рабочую
 * карточку с плашкой «Возвращён мастером…», и баннер пропадёт на
 * следующем рендере страницы (SSR; на /qc стоит `force-dynamic`).
 */
function IncomingReworksBanner({ items }: { items: QcIncomingReworkDto[] }) {
  const heading =
    items.length === 1
      ? 'Возвращён на повторную проверку'
      : `Возвращены на повторную проверку (${items.length})`;
  return (
    <div
      className="scan-card scan-card--simple"
      role="status"
      aria-label="Возвращены на повторную проверку"
    >
      <h2 className="scan-card__title">
        <Icon name="warning" size={22} />
        <span style={{ marginLeft: '0.45rem' }}>{heading}</span>
      </h2>
      <p className="scan-card__hint">
        Отсканируйте QR паспорта, чтобы начать повторную проверку.
      </p>
      <ul
        style={{
          margin: 0,
          padding: '0.25rem 0 0 1.1rem',
          fontSize: '0.95rem',
          lineHeight: 1.4,
        }}
      >
        {items.map((p) => (
          <li key={p.passportId}>
            <strong>{p.passportNumber}</strong>
            {' · '}
            {p.productName}
            {' · '}
            {p.color}
            {' · '}
            {p.sizeCode}
          </li>
        ))}
      </ul>
    </div>
  );
}
