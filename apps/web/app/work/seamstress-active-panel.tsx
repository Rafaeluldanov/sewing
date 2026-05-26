'use client';

/**
 * Mobile-first активный экран швеи на /work.
 *
 * Сценарий (ТЗ §3–§6):
 *   - одна primary-кнопка «Взять крой» → открывает камеру;
 *   - после скана QR паспорта — модалка визуальной сверки
 *     (см. `passport-confirm-modal.tsx`);
 *   - «Принять» → выполняем штатный issue, показываем success-state
 *     с кнопкой «Взять следующий крой» — цикл сразу замыкается.
 *
 * Когда у швеи уже есть активный крой, ниже показываем secondary-
 * кнопку «Завершить операцию»: тот же UX (скан → подтверждение →
 * success), но на backend идём в `POST /api/passports/:id/complete-operation`.
 * См. ТЗ «завершение операции швеёй через скан паспорта» и
 * `docs/flows.md §F4a`.
 *
 * Никаких табов «Получить крой / Сканировать паспорт» — для швеи
 * `issue` и есть основной (и единственный из /work) сценарий. Финализация
 * смены и logout вынесены в три-точечное меню действий
 * (см. `seamstress-actions-menu.tsx`).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ModalPortal } from '@/components/modal-portal';
import type {
  CurrentWorkPassportDto,
  ReworkPassportDto,
  ShiftSessionDto,
} from '@sewing/shared/shifts';
import type {
  OrderCutIssueRuleBannerDto,
  OrderCutIssueRuleBannerOrderDto,
} from '@sewing/shared';
import { QrScannerModal } from './qr-scanner-modal';
import {
  PassportConfirmModal,
  type PassportConfirmData,
} from './passport-confirm-modal';
import {
  acceptPassportForIssueAction,
  completePassportOperationAction,
  lookupPassportAction,
} from './actions';
import { CurrentWorkCard } from './current-work-card';
import { CutIssueRuleBanner } from './cut-issue-rule-banner';
import {
  playCutAcceptedSound,
  playOperationCompletedSound,
} from './feedback';

interface Props {
  shift: ShiftSessionDto;
  /**
   * Активные кройи, закреплённые за швеёй сейчас. Источник —
   * `GET /api/shifts/current-work`, грузится в server-component
   * (`page.tsx`). После `acceptPassportForIssueAction` /
   * `completePassportOperationAction` мы зовём `router.refresh()`,
   * чтобы серверный proxy перевыполнился и этот prop обновился
   * (`revalidatePath('/work')` в action инвалидирует RSC-кэш).
   */
  currentWork: CurrentWorkPassportDto[];
  /**
   * Подсказка «Очередь выдачи кроя» для текущей операции швеи
   * (см. `OrderCutIssueRulesService.getActiveBannerForOperation`).
   * Используется и для постоянного баннера сверху, и для
   * pre-issue проверки размера в `lookup`-flow: если паспорт
   * относится к заказу из баннера, но его `sizeCode` не совпадает
   * с `currentSizeCode` — поднимаем модалку «не тот размер»
   * вместо `PassportConfirmModal`.
   */
  cutIssueBanner: OrderCutIssueRuleBannerDto;
  /**
   * Паспорта, возвращённые ОТК на переделку этой швее (см.
   * `QcService.returnToRework`, `docs/flows.md §F5a`). Список
   * — только подсказка «заберите у ОТК, потом сосканируйте у
   * станка как обычно»; жёсткой привязки `currentEmployeeId`
   * после rework нет. Источник — `GET /api/shifts/my-rework`.
   */
  myRework: ReworkPassportDto[];
}

/**
 * Режим открытого сканера / модалки подтверждения. Флоу «взять крой»
 * (issue) и «завершить операцию» (complete) одинаковы по UX, но ведут в
 * разные endpoints с разным success-сообщением и разным звуком.
 */
type FlowMode = 'issue' | 'complete';

export function SeamstressActivePanel({
  shift,
  currentWork,
  cutIssueBanner,
  myRework,
}: Props) {
  const router = useRouter();

  const [scannerOpen, setScannerOpen] = useState<FlowMode | null>(null);
  const [confirmMode, setConfirmMode] = useState<FlowMode | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [confirm, setConfirm] = useState<PassportConfirmData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>(
    undefined,
  );
  /**
   * Состояние модалки «не тот размер» — поднимается, когда после
   * успешного `lookupPassportAction` мы локально сравнили
   * `passport.sizeCode` с `currentSizeCode` соответствующего
   * заказа из `cutIssueBanner` и обнаружили расхождение. Это
   * UX-оптимизация поверх жёсткой серверной проверки в
   * `evaluateForIssue` (она бы всё равно вернула 409 на
   * `acceptForIssue`, но швея бы успела зря пройти модалку
   * визуальной сверки).
   */
  const [wrongSize, setWrongSize] = useState<{
    scannedSize: string;
    expected: OrderCutIssueRuleBannerOrderDto;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const lookup = (code: string, mode: FlowMode) => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Введите или отсканируйте код паспорта');
      return;
    }
    setError(null);
    setErrorRequestId(undefined);
    setWrongSize(null);
    startTransition(async () => {
      const res = await lookupPassportAction(trimmed);
      if (!res.ok) {
        setError(res.error);
        setErrorRequestId(res.errorRequestId);
        return;
      }
      // Pre-issue проверка очереди выдачи (вариант 2 ТЗ §4):
      // если паспорт принадлежит заказу из активного баннера и
      // его размер не совпадает с currentSizeCode — поднимаем
      // модалку «не тот размер» ВМЕСТО `PassportConfirmModal`.
      // Для `complete`-flow эту проверку не делаем: завершение
      // операции по своему паспорту не регулируется очередью
      // выдачи (правило применяется только на первой выдаче).
      if (mode === 'issue' && cutIssueBanner.applicable) {
        const expected = cutIssueBanner.orders.find(
          (o) => o.orderId === res.passport.orderId,
        );
        if (expected && expected.currentSizeCode !== res.passport.sizeCode) {
          setWrongSize({
            scannedSize: res.passport.sizeCode,
            expected,
          });
          return;
        }
      }
      setConfirmMode(mode);
      setConfirm(res.passport);
    });
  };

  const handleScan = (decoded: string) => {
    const mode = scannerOpen ?? 'issue';
    setScannerOpen(null);
    lookup(decoded, mode);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Ручной ввод кода на MVP покрывает только сценарий «Взять крой»:
    // завершение всегда инициируется через скан QR того паспорта,
    // который уже закреплён за швеёй (ТЗ §1, §7.2).
    lookup(manualCode, 'issue');
  };

  const handleAccept = () => {
    if (!confirm || !confirmMode) return;
    if (confirmMode === 'issue') {
      startTransition(async () => {
        const res = await acceptPassportForIssueAction(confirm.id);
        if (res.error) {
          setError(res.error);
          setErrorRequestId(res.errorRequestId);
          setConfirm(null);
          setConfirmMode(null);
          return;
        }
        // Звук — только при подтверждённом backend SUCCESS. Никаких
        // оптимистичных проигрываний на открытии модалки или на cancel:
        // швея слышит «дзынь» ровно в момент, когда крой действительно
        // принят (см. `feedback.ts`).
        playCutAcceptedSound();
        setConfirm(null);
        setConfirmMode(null);
        router.refresh();
      });
      return;
    }
    // complete — завершение операции.
    startTransition(async () => {
      const res = await completePassportOperationAction(confirm.id);
      if (res.error) {
        setError(res.error);
        setErrorRequestId(res.errorRequestId);
        setConfirm(null);
        setConfirmMode(null);
        return;
      }
      // Отдельное звучание, чтобы ухом отличать «приняла» от «сдала»
      // (ТЗ §4). Web Audio, без внешнего ассета — см. `feedback.ts`.
      playOperationCompletedSound();
      setConfirm(null);
      setConfirmMode(null);
      // revalidatePath + router.refresh → «Текущий крой» мгновенно
      // избавится от закрытого паспорта (backend фильтрует по
      // `currentEmployeeId`, который мы сняли в транзакции).
      router.refresh();
    });
  };

  const handleCancelConfirm = () => {
    if (isPending) return;
    setConfirm(null);
    setConfirmMode(null);
  };

  // -------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------

  const hasActive = currentWork.length > 0;
  const primaryLabel = hasActive ? 'Взять следующий крой' : 'Взять крой';

  return (
    <div className="seamstress-work">
      <CutIssueRuleBanner banner={cutIssueBanner} />

      <div className="scan-card scan-card--simple" aria-label="Взять крой">
        <div>
          <h2 className="scan-card__title">{primaryLabel}</h2>
          <p className="scan-card__hint">
            {/* Подсказка нейтральная: после soft-route MVP паспорт может
                прийти как из ячейки (legacy / буфер), так и прямо из
                маршрутного потока без ячейки. Ветку выбирает backend
                (`PassportsService.issueToEmployee`); в обоих случаях
                откроется одна и та же модалка проверки, поэтому хинт
                не привязываем к складской модели. */}
            Сканируйте QR паспорта — откроется проверка перед приёмом.
          </p>
        </div>

        {error && (
          <div className="error-box" role="alert">
            <div className="error-box__msg">{error}</div>
            {errorRequestId && (
              <div className="error-box__rid">
                req: <code>{errorRequestId}</code>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary btn-lg btn-block scan-card__primary-camera"
          onClick={() => {
            setError(null);
            setErrorRequestId(undefined);
            setScannerOpen('issue');
          }}
          disabled={isPending}
        >
          {isPending ? 'Загрузка…' : primaryLabel}
        </button>

        {hasActive && (
          <button
            type="button"
            className="btn btn-block btn-lg scan-card__secondary-camera"
            onClick={() => {
              setError(null);
              setErrorRequestId(undefined);
              setScannerOpen('complete');
            }}
            disabled={isPending}
            aria-label="Завершить операцию по паспорту"
          >
            Завершить операцию
          </button>
        )}

        {manualOpen ? (
          <form
            onSubmit={handleManualSubmit}
            className="seamstress-start__manual"
            aria-label="Ввести код паспорта вручную"
          >
            <label
              className="scan-card__input"
              htmlFor="seamstress-passport-code"
            >
              <span className="scan-card__input-label">Код паспорта</span>
              <input
                id="seamstress-passport-code"
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

      {myRework.length > 0 && <ReworkSection items={myRework} />}

      <CurrentWorkCard
        items={currentWork}
        shiftOperationId={shift.operationId}
      />

      {scannerOpen && (
        <QrScannerModal
          onScan={handleScan}
          onClose={() => setScannerOpen(null)}
        />
      )}
      {confirm && confirmMode === 'issue' && (
        <PassportConfirmModal
          passport={confirm}
          shift={shift}
          onAccept={handleAccept}
          onCancel={handleCancelConfirm}
          pending={isPending}
        />
      )}
      {confirm && confirmMode === 'complete' && (
        <PassportConfirmModal
          passport={confirm}
          shift={shift}
          onAccept={handleAccept}
          onCancel={handleCancelConfirm}
          pending={isPending}
          title="Завершить операцию"
          acceptLabel="Завершить"
          pendingLabel="Завершаем…"
        />
      )}
      {wrongSize && (
        <WrongSizeModal
          scannedSize={wrongSize.scannedSize}
          expected={wrongSize.expected}
          onClose={() => setWrongSize(null)}
        />
      )}
    </div>
  );
}

/**
 * Секция «К переделке от ОТК» на /work. Показывается только если
 * `myRework.length > 0` (см. `SeamstressActivePanel`). Источник —
 * `GET /api/shifts/my-rework` (`ShiftsService.getMyReworkPassports`,
 * `docs/flows.md §F5a`).
 *
 * Это подсказка: физически паспорт на столе у ОТК, швея подходит,
 * забирает и сканирует у своего станка обычным сценарием «Взять
 * крой». После завершения переделки и нового `OPERATION_FINISHED`
 * паспорт автоматически уходит из этой секции.
 */
function ReworkSection({ items }: { items: ReworkPassportDto[] }) {
  return (
    <section className="card rework-section" aria-label="К переделке от ОТК">
      <h2 className="card__title">
        ⚠ К переделке от ОТК ({items.length})
      </h2>
      <p className="card__hint">
        Заберите паспорт у ОТК и сосканируйте у своего станка кнопкой
        «Взять крой».
      </p>
      <ul className="rework-section__list">
        {items.map((p) => (
          <li key={`${p.passportId}:${p.operationCode}`}>
            <strong>{p.passportNumber}</strong> · {p.operationName} ·{' '}
            {p.productName}, {p.color}, {p.sizeCode} · {p.qtyGood} шт.
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Модалка «не тот размер» для seamstress flow на /work.
 *
 * Поднимается из `lookup`-flow до `PassportConfirmModal`, когда
 * швея отсканировала паспорт с `sizeCode`, не совпадающим с
 * текущим разрешённым размером очереди по этому заказу. Это
 * полностью UI-проверка: реальная защита остаётся на бэке
 * (`OrderCutIssueRulesService.evaluateForIssue` бросит 409 при
 * `acceptForIssue`), но модалка экономит швее шаг визуальной
 * сверки.
 */
function WrongSizeModal({
  scannedSize,
  expected,
  onClose,
}: {
  scannedSize: string;
  expected: OrderCutIssueRuleBannerOrderDto;
  onClose: () => void;
}) {
  return (
    <ModalPortal>
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wrong-size"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wrong-size-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="wrong-size-title" className="modal__title">
          Не тот размер
        </h2>
        <p className="modal__text">
          Этот паспорт размера <b>{scannedSize}</b>, а сейчас по заказу №
          {expected.orderNumber} разрешён только{' '}
          <b>{expected.currentSizeCode}</b>.
        </p>
        <p className="modal__text">
          Осталось выдать: {expected.remainingQty} шт ({expected.issuedQty}/
          {expected.requiredQty}).
        </p>
        {expected.cells.length > 0 ? (
          <div className="modal__cells">
            <div className="modal__cells-label">Возьмите паспорт из ячейки:</div>
            <ul className="modal__cells-list">
              {expected.cells.map((c) => (
                <li key={c.cellId}>
                  <b>{c.cellCode}</b> — {c.passportsCount} шт
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="modal__text modal__text--muted">
            Сейчас нет паспортов размера {expected.currentSizeCode} в ячейках —
            обратитесь к мастеру.
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
