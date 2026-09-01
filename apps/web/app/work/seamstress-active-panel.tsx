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

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ModalPortal } from '@/components/modal-portal';
import type {
  CurrentWorkPassportDto,
  ReworkPassportDto,
  ShiftSessionDto,
  UnclosedWorkPassportDto,
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
  closeUnclosedOperationAction,
  completePassportOperationAction,
  loadMyReworkAction,
  lookupPassportAction,
} from './actions';
import { CurrentWorkCard } from './current-work-card';
import { SEAMSTRESS_WORDING, type WorkWording } from './work-wording';
import { CutIssueRuleBanner } from './cut-issue-rule-banner';
import { ReworkPushSetup } from './rework-push-setup';
import {
  armReworkAudio,
  playCutAcceptedSound,
  playOperationCompletedSound,
  playReworkAlertSound,
  triggerReworkHaptic,
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
  /**
   * Паспорта, по которым у сотрудника осталась незакрытая операция, а
   * сам паспорт уже уехал дальше по маршруту. Источник — `GET
   * /api/shifts/my-unclosed` (`ShiftsService.getMyUnclosedPassports`).
   * До 01.09.2026 такой паспорт исчезал с экрана бесследно: скан
   * следующего исполнителя (в т.ч. ОТК) перезаписывал
   * `currentEmployeeId`, работа оставалась без `OPERATION_FINISHED` и
   * без начисления, и человек об этом просто не узнавал.
   */
  myUnclosed: UnclosedWorkPassportDto[];
  /**
   * Ролевые подписи панели (см. `work-wording.ts`). По умолчанию —
   * швейные («Взять крой»). `/packing` в режиме некоробочной операции
   * («Распаковка» = приёмка сырья) передаёт свой словарь: кроя на том
   * шаге ещё нет, и кнопка «Взять крой» вводила бы упаковщика в
   * заблуждение.
   */
  wording?: WorkWording;
}

/**
 * Режим открытого сканера / модалки подтверждения. Флоу «взять крой»
 * (issue) и «завершить операцию» (complete) одинаковы по UX, но ведут в
 * разные endpoints с разным success-сообщением и разным звуком.
 */
type FlowMode = 'issue' | 'complete';

/**
 * Период фонового опроса `/shifts/my-rework`. У флоу нет push/SSE
 * (см. `docs/flows.md §F5a`), поэтому новый брак детектим поллингом.
 * 15 с — компромисс: швея узнаёт о возврате почти сразу, а нагрузка
 * на API копеечная (1 запрос на швею раз в 15 с).
 */
const REWORK_POLL_INTERVAL_MS = 15_000;

/**
 * Пока открыт модал тревоги — повторяем звук, чтобы швея не
 * «прослушала» единичный сигнал за станком. Останавливается в момент,
 * когда она нажимает «Понятно».
 */
const REWORK_ALERT_REPEAT_MS = 4_000;

/** Стабильный ключ записи переделки — как в списке `ReworkSection`. */
function reworkKey(p: ReworkPassportDto): string {
  return `${p.passportId}:${p.operationCode}`;
}

export function SeamstressActivePanel({
  shift,
  currentWork,
  cutIssueBanner,
  myRework,
  myUnclosed,
  wording = SEAMSTRESS_WORDING,
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
  // Мягкое предупреждение (не ошибка) — гейт «крой не размещён в
  // ячейке»: сначала нужно разместить паспорт в ячейку. Показываем
  // жёлтой плашкой, а не красной ошибкой (см. `WorkFormState.warning`).
  const [warning, setWarning] = useState<string | null>(null);
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

  // -------------------------------------------------------------------
  // Тревога «пришёл брак от ОТК»
  //
  // Секция `ReworkSection` сама по себе пассивна — швея увидит её
  // только если смотрит на экран. Чтобы возврат на переделку реально
  // приоритизировался, поллим `/shifts/my-rework` и при появлении
  // НОВОЙ записи (ключа, которого не было) поднимаем блокирующий
  // модал + звук + вибрацию.
  //
  // `seenReworkRef` инициализируем текущими ключами из server-prop,
  // чтобы НЕ трубить тревогу о браке, который уже висел на экране при
  // загрузке смены, — сигналим только про действительно новые.
  // -------------------------------------------------------------------
  const seenReworkRef = useRef<Set<string>>(
    new Set(myRework.map(reworkKey)),
  );
  const [reworkAlert, setReworkAlert] = useState<ReworkPassportDto[] | null>(
    null,
  );

  const processRework = useCallback((list: ReworkPassportDto[]) => {
    const fresh = list.filter((p) => !seenReworkRef.current.has(reworkKey(p)));
    if (fresh.length === 0) return;
    for (const p of fresh) seenReworkRef.current.add(reworkKey(p));
    playReworkAlertSound();
    triggerReworkHaptic();
    // Накапливаем: если пока открыт модал прилетела ещё одна переделка,
    // показываем все непогашенные разом.
    setReworkAlert((prev) => [...(prev ?? []), ...fresh]);
  }, []);

  // «Будим» аудио-контекст на первом касании — иначе autoplay-политика
  // заглушит тревогу, играющую вне user gesture (из поллинга).
  useEffect(() => armReworkAudio(), []);

  // Фоновый поллинг переделок.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await loadMyReworkAction();
        if (!cancelled) processRework(list);
      } catch {
        /* fail-soft: фоновый опрос не должен ломать рабочий экран */
      }
    };
    const id = window.setInterval(tick, REWORK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [processRework]);

  // Новый брак мог приехать и через server-prop (после router.refresh
  // на завершении операции). Прогоняем prop через тот же детектор —
  // дубли отсекает `seenReworkRef`.
  useEffect(() => {
    processRework(myRework);
  }, [myRework, processRework]);

  // Повтор сигнала, пока модал тревоги открыт.
  useEffect(() => {
    if (!reworkAlert || reworkAlert.length === 0) return;
    const id = window.setInterval(() => {
      playReworkAlertSound();
      triggerReworkHaptic();
    }, REWORK_ALERT_REPEAT_MS);
    return () => window.clearInterval(id);
  }, [reworkAlert]);

  const lookup = (code: string, mode: FlowMode) => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Введите или отсканируйте код паспорта');
      return;
    }
    setError(null);
    setErrorRequestId(undefined);
    setWarning(null);
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
        if (res.warning) {
          // Гейт размещения — спокойное предупреждение, не ошибка.
          setWarning(res.warning);
          setConfirm(null);
          setConfirmMode(null);
          return;
        }
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
  const primaryLabel = hasActive ? wording.takeNext : wording.take;

  return (
    <div className="seamstress-work">
      <CutIssueRuleBanner banner={cutIssueBanner} />

      <div className="scan-card scan-card--simple" aria-label={wording.take}>
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

        {warning && (
          <div className="warning-box" role="status">
            <div className="warning-box__msg">{warning}</div>
          </div>
        )}

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
            setWarning(null);
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

      {myRework.length > 0 && (
        <ReworkSection items={myRework} takeLabel={wording.take} />
      )}

      {myUnclosed.length > 0 && <UnclosedSection items={myUnclosed} />}

      <ReworkPushSetup />

      <CurrentWorkCard
        items={currentWork}
        shiftOperationId={shift.operationId}
        emptyText={wording.emptyText}
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
      {reworkAlert && reworkAlert.length > 0 && (
        <ReworkAlertModal
          items={reworkAlert}
          takeLabel={wording.take}
          onAcknowledge={() => setReworkAlert(null)}
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
function ReworkSection({
  items,
  takeLabel,
}: {
  items: ReworkPassportDto[];
  takeLabel: string;
}) {
  return (
    <section className="card rework-section" aria-label="К переделке от ОТК">
      <h2 className="card__title">
        ⚠ К переделке от ОТК ({items.length})
      </h2>
      <p className="card__hint">
        Заберите паспорт у ОТК и сосканируйте у своего рабочего места
        кнопкой «{takeLabel}».
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
 * Секция «Не закрыто вами» на /work. Источник — `GET
 * /api/shifts/my-unclosed` (`ShiftsService.getMyUnclosedPassports`).
 *
 * Что это. Человек взял паспорт на операцию, сделал работу, но не
 * нажал «Завершить» — а паспорт тем временем увёл дальше по маршруту
 * следующий исполнитель (до 01.09.2026 это мог сделать и ОТК: гейт не
 * проверял шаг, на котором паспорт СТОИТ, см.
 * `PassportsService.evaluateRouteOrder::currentStepCandidate`). Паспорт
 * пропадал из «В работе у вас», `OPERATION_FINISHED` не появлялся, а
 * без него нет `OperationEntry` — сделка за сделанную работу не
 * начислялась никому.
 *
 * Почему кнопка закрывает операцию НА МЕСТЕ, а не отправляет искать
 * паспорт: он физически уже у ОТК/ВТО/в буфере, и для фиксации работы
 * не нужен. Альтернатива — пере-сканировать его у себя — тянет паспорт
 * НАЗАД по маршруту и заставляет второй раз проходить ОТК (инцидент
 * 31.08.2026, заказ 02-00020).
 *
 * Строка обязана отвечать «где паспорт сейчас»: это и есть ответ на
 * «чтобы долго не искала».
 */
function UnclosedSection({ items }: { items: UnclosedWorkPassportDto[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const close = (passportId: string) => {
    setPendingId(passportId);
    setError(null);
    void closeUnclosedOperationAction(passportId).then((res) => {
      setPendingId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      // Строка уходит из списка только после перечитывания server-
      // component: источник истины — БД, локально ничего не вычёркиваем.
      router.refresh();
    });
  };

  return (
    <section className="card unclosed-section" aria-label="Не закрыто вами">
      <h2 className="card__title">⚠ Не закрыто вами ({items.length})</h2>
      <p className="card__hint">
        Вы брали эти паспорта, но не закрыли операцию — паспорт успели
        забрать дальше. Работа не зачтена. Искать паспорт не нужно:
        нажмите «Закрыть операцию».
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <ul className="unclosed-section__list">
        {items.map((p) => (
          <li key={`${p.passportId}:${p.operationId}`}>
            <div>
              <strong>{p.passportNumber}</strong> · {p.operationName} ·{' '}
              {p.qtyGood} шт.
            </div>
            <div className="unclosed-section__where">
              Заказ {p.orderNumber} · {p.productName}, {p.color}, {p.sizeCode}
              {' · '}
              {describeWhere(p)}
            </div>
            <button
              type="button"
              className="btn unclosed-section__btn"
              onClick={() => close(p.passportId)}
              disabled={pendingId !== null}
            >
              {pendingId === p.passportId ? 'Закрываем…' : 'Закрыть операцию'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «Где паспорт сейчас» одной строкой — от точного к общему. */
function describeWhere(p: UnclosedWorkPassportDto): string {
  if (p.heldByEmployeeName) return `сейчас у ${p.heldByEmployeeName}`;
  if (p.cellCode) return `сейчас в ячейке ${p.cellCode}`;
  if (p.standsOnOperationName) return `сейчас на «${p.standsOnOperationName}»`;
  return 'ушёл дальше по маршруту';
}

/**
 * Блокирующий модал «Пришёл брак!» — поднимается из поллинга
 * `/shifts/my-rework`, когда ОТК вернул швее новый паспорт на
 * переделку (см. `SeamstressActivePanel`). В отличие от пассивной
 * `ReworkSection`, перекрывает экран и сопровождается звуком +
 * вибрацией (`feedback.ts`), который повторяется, пока швея не нажмёт
 * «Понятно» — цель в том, чтобы переделка приоритизировалась, а не
 * терялась на фоне текущей работы.
 *
 * Сознательно НЕ закрывается по клику на backdrop: подтверждение
 * должно быть явным (иначе случайный тап по экрану за станком погасит
 * тревогу незаметно).
 */
function ReworkAlertModal({
  items,
  takeLabel,
  onAcknowledge,
}: {
  items: ReworkPassportDto[];
  takeLabel: string;
  onAcknowledge: () => void;
}) {
  return (
    <ModalPortal>
      <div className="modal-backdrop" role="presentation">
        <div
          className="modal modal--rework-alert"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rework-alert-title"
        >
          <h2 id="rework-alert-title" className="modal__title">
            ⚠ Пришёл брак от ОТК ({items.length})
          </h2>
          <p className="modal__text">
            Заберите паспорт у ОТК и сосканируйте у своего рабочего места
            кнопкой «{takeLabel}». Сделайте это в первую очередь.
          </p>
          <ul className="rework-section__list">
            {items.map((p) => (
              <li key={reworkKey(p)}>
                <strong>{p.passportNumber}</strong> · {p.operationName} ·{' '}
                {p.productName}, {p.color}, {p.sizeCode} · {p.qtyGood} шт.
              </li>
            ))}
          </ul>
          <div className="modal__actions">
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={onAcknowledge}
              autoFocus
            >
              Понятно
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
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
