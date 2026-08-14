'use client';

/**
 * Mobile-first scan-driven рабочее окно упаковщика (`/packing`).
 *
 * У окна ДВА режима, и выбирает их операция активной смены:
 *
 *   A. **Коробочная упаковка** (`Operation.boxPacking = true`) — всё,
 *      что описано ниже: коробка + сканы паспортов в неё + закрытие.
 *   B. **Обычная производственная операция упаковщика**
 *      (`boxPacking = false`) — рендерим `SeamstressActivePanel` из
 *      `/work`: скан паспорта → «взять» / «завершить операцию», без
 *      коробок и без гейтов ОТК/ВТО.
 *
 * Почему признак, а не категория: в маршруте заказа операций категории
 * `PACKING` бывает несколько — «Распаковка» (приёмка и распаковка
 * приходящего сырья) стоит ПЕРВЫМ шагом, «Упаковка» (коробки) —
 * последним. Пока развилка шла по `category === 'PACKING'`, смена на
 * «Распаковке» открывала окно коробок, и первый же скан валился 409
 * `PASSPORT_NOT_QC_PASSED`: гейт финальной упаковки в
 * `PackingService.addPassport` требует пройденных ОТК/ВТО. Теперь
 * единственный источник истины — `Operation.boxPacking` (он же
 * определяет `assertPackingActor` и выбор упаковочного шага маршрута).
 * Не путать с `Operation.producesFinishedGoods` — та ось про финансовый
 * выпуск готовой продукции (`FinishedGoodsMovement`).
 *
 * Архитектура режима A повторяет `QcTerminal` / `WtoTerminal` — единое
 * окно с минимумом кликов, всё крутится вокруг физического сканера QR.
 * Отличие от ОТК/ВТО — у упаковщика два уровня state:
 *
 *   1. **Коробка** — её надо сначала «открыть» (`createBoxTerminalAction`)
 *      и держать в памяти терминала между сканами.
 *   2. **Паспорт** — каждый скан добавляется в текущую коробку
 *      (`scanPassportToBoxAction`), и сразу же отображается в
 *      сводном списке внутри карточки коробки.
 *
 * Закрытие коробки (`closeBoxTerminalAction`) — финальный шаг
 * цепочки: backend в этой же транзакции апрувит все pending-начисления
 * по упакованным паспортам (см. ADR-0005 §«Подтверждение»,
 * `docs/flows.md §F7`). После закрытия — карточку гасим, упаковщик
 * нажимает «Создать коробку» и flow повторяется.
 *
 * Обратная совместимость: страницы `/packing/boxes/[id]` и форма
 * «Новая коробка» в SHOP_MANAGER/ADMIN-вьюхе списка остались — они
 * используют старые form-actions из `actions.ts` (см. legacy-блок).
 * Сам терминал ходит через client-actions
 * `*TerminalAction`/`scanPassportToBoxAction`/`getActiveBoxAction`,
 * которые возвращают `BoxDetailDto`, а не `redirect`/`revalidate`-only.
 */

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { BoxDetailDto, BoxListItemDto } from '@sewing/shared/packing';
import type { OrderCutIssueRuleBannerDto } from '@sewing/shared';
import type {
  CurrentWorkPassportDto,
  EmployeeLiteDto,
  OperationLiteDto,
  ReworkPassportDto,
  ShiftMetaDto,
  ShiftSessionDto,
} from '@sewing/shared/shifts';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  playCutAcceptedSound,
  playOperationCompletedSound,
} from '@/app/work/feedback';
import { SeamstressShiftStart } from '@/app/work/seamstress-shift-start';
import { SeamstressActivePanel } from '@/app/work/seamstress-active-panel';
import { SeamstressActionsMenu } from '@/app/work/seamstress-actions-menu';
import { OperationSwitcher } from '@/app/work/operation-switcher';
import { PACKING_INTAKE_WORDING } from '@/app/work/work-wording';
import { Icon } from '@/components/icon';
import { PassportsInWorkCard } from '@/components/passports-in-work-card';
import {
  closeBoxTerminalAction,
  createBoxTerminalAction,
  getActiveBoxAction,
  listClosedUnplacedBoxesTerminalAction,
  listOpenBoxesTerminalAction,
  placeBoxTerminalAction,
  scanPassportToBoxAction,
} from './actions';

/**
 * localStorage-ключ, под которым храним id «активной» коробки между
 * перезагрузками страницы. Это удобство для упаковщика: в цеху
 * вкладка может «уснуть» / переоткрыться, а коробка по факту ещё
 * открыта в БД — найдём её обратно по id и продолжим работу. Если
 * id невалиден или коробка закрыта — тихо забываем.
 */
const ACTIVE_BOX_STORAGE_KEY = 'sewing.packing.activeBoxId';

interface ErrorState {
  message: string;
  requestId?: string;
}

interface Props {
  meta: ShiftMetaDto;
  employee: EmployeeLiteDto;
  initialShift: ShiftSessionDto | null;
  /**
   * Категория операции, на которой упаковщик сейчас работает.
   * Если активной смены нет — `null`. Если активная смена есть, но
   * категория не `PACKING` (например, упаковщик случайно начал смену
   * на другой операции) — терминал покажет `WrongOperationCard`.
   *
   * Внутри категории `PACKING` режим выбирает уже не она, а
   * `activeOperationBoxPacking` (см. блок-комментарий файла).
   */
  activeOperationCategory: string | null;
  /**
   * `Operation.boxPacking` операции активной смены — «эта операция
   * складывает паспорта в коробки». Единственный признак, включающий
   * окно коробок; он же на бэке решает `PackingService
   * .assertPackingActor` и поиск упаковочного шага маршрута в
   * `addPassport`. `false` (в т.ч. когда смены нет) — коробок не будет.
   */
  activeOperationBoxPacking: boolean;
  /**
   * Операции, разрешённые на рабочем месте текущей смены
   * (`EquipmentOperation`). Если их 2+, рендерим `OperationSwitcher` —
   * упаковщик переходит с «Упаковки» на «Распаковку» и обратно, не
   * завершая смену: рабочее место одно и то же, меняется только
   * операция. Меньше двух — переключать не на что, компонент сам
   * вернёт `null`.
   */
  availableOperations: OperationLiteDto[];
  /**
   * Активные паспорта упаковщика — для режима обычной операции
   * (`SeamstressActivePanel`). В режиме коробок не используется и
   * приезжает пустым (`packing/page.tsx` его не грузит).
   */
  currentWork: CurrentWorkPassportDto[];
  /**
   * Баннер «Очередь выдачи кроя» для операции смены. Нужен той же
   * `SeamstressActivePanel`; на «Распаковке» (первый шаг маршрута)
   * он как раз применим — см. `getCutIssueBanner`.
   */
  cutIssueBanner: OrderCutIssueRuleBannerDto;
  /**
   * Возвраты от ОТК на переделку — подсказка внутри
   * `SeamstressActivePanel`. В режиме коробок пустой.
   */
  myRework: ReworkPassportDto[];
  /**
   * SSR-снимок незакрытых (`OPEN`) коробок. На Stage 1 терминала
   * (когда нет активной карточки) выводится списком — упаковщик
   * может вернуться к любой коробке (своей или коллеги) одним
   * кликом, не вспоминая id и не теряя коробки между устройствами.
   * Источник истины — backend (`GET /api/packing/boxes?status=OPEN`);
   * клиент дополнительно перечитывает этот список после закрытия
   * коробки и при ручном refresh.
   */
  initialOpenBoxes: BoxListItemDto[];
  /**
   * SSR-снимок «закрытых, но ещё не размещённых» коробок
   * (`?status=CLOSED&placed=false`). Упаковщик видит, какие коробки
   * упакованы и ждут разноса по ячейкам склада. Кнопка «Разместить»
   * на строке открывает скан QR ячейки → `placeBoxTerminalAction`,
   * после чего коробка пропадает из списка (`Box.placedAt`).
   */
  initialClosedUnplacedBoxes: BoxListItemDto[];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function PackingTerminal({
  meta,
  employee,
  initialShift,
  activeOperationCategory,
  activeOperationBoxPacking,
  availableOperations,
  currentWork,
  cutIssueBanner,
  myRework,
  initialOpenBoxes,
  initialClosedUnplacedBoxes,
}: Props) {
  const isShiftActive = !!(initialShift && initialShift.active);
  // Режим A — коробки. Решает ТОЛЬКО `Operation.boxPacking`: категории
  // `PACKING` здесь мало, в ней же лежит «Распаковка» (см. шапку файла).
  const onBoxPackingShift = isShiftActive && activeOperationBoxPacking;
  // Режим B — обычная производственная операция упаковщика: смена есть,
  // операция «его» категории, но коробок не собирает.
  const onPlainPackingShift =
    isShiftActive &&
    !activeOperationBoxPacking &&
    activeOperationCategory === 'PACKING';

  return (
    <div className="seamstress-work">
      {/*
       * `SeamstressActionsMenu` для упаковщика — то же три-точечное
       * меню, что и у швеи: «Завершить смену» (если активна) + «Выйти».
       * Это нужно для всех веток, потому что `<AppHeader>` на `/packing`
       * для PACKING-роли скрыт (см. `components/app-header.tsx`).
       */}
      <SeamstressActionsMenu shiftActive={isShiftActive} />

      {/*
       * Chip «Сменить операцию» — над обеими рабочими ветками. Смысл
       * именно для упаковщика: «Упаковка» и «Распаковка» живут на ОДНОМ
       * рабочем месте, и гонять человека через «Завершить смену → снова
       * сканировать стол» ради переключения незачем. Backend не даст
       * переключиться, пока на руках есть незакрытые паспорта
       * (`SHIFT_HAS_ACTIVE_PASSPORTS`), — сообщение компонент покажет
       * сам. Если на рабочем месте разрешена одна операция, вернёт null.
       */}
      {isShiftActive && (
        <OperationSwitcher
          shift={initialShift!}
          availableOperations={availableOperations}
        />
      )}

      {/*
       * «В работе у вас» — только для коробочного режима. В швейном
       * режиме те же паспорта уже рисует `SeamstressActivePanel`
       * (`currentWork`), дублировать нечего.
       *
       * Зачем в коробках: паспорт, взятый на «Распаковке», числится за
       * упаковщиком до закрытия операции, и `switchOperation` из-за
       * него отвечает `SHIFT_HAS_ACTIVE_PASSPORTS`. Раньше в этом
       * режиме список не грузился вовсе — паспорт пропадал с экрана, и
       * причина отказа была невидимой. Строки не кликабельны: закрыть
       * такой паспорт можно только на его операции (см. подсказку).
       */}
      {onBoxPackingShift && (
        <PassportsInWorkCard
          items={currentWork}
          hint="Паспорт числится за вами с другой операции и не закрыт — пока он на руках, сменить операцию нельзя. Завершите смену и начните новую на его операции, чтобы закрыть, либо попросите мастера снять паспорт с вас."
        />
      )}

      {!isShiftActive ? (
        <SeamstressShiftStart meta={meta} employee={employee} />
      ) : onBoxPackingShift ? (
        <PackingMainTerminal
          shift={initialShift!}
          initialOpenBoxes={initialOpenBoxes}
          initialClosedUnplacedBoxes={initialClosedUnplacedBoxes}
        />
      ) : onPlainPackingShift ? (
        /*
         * Режим B — «Распаковка» и прочие операции упаковщика без
         * коробок. Экран тот же, что у швеи на `/work`: скан паспорта →
         * «взять» / «завершить операцию». Отдельного компонента не
         * заводим сознательно — flow идентичен, а дубль разъехался бы
         * при первой же правке швейного окна.
         */
        <SeamstressActivePanel
          shift={initialShift!}
          currentWork={currentWork}
          cutIssueBanner={cutIssueBanner}
          myRework={myRework}
          wording={PACKING_INTAKE_WORDING}
        />
      ) : (
        <WrongOperationCard operationName={initialShift!.operationName} />
      )}
    </div>
  );
}

function WrongOperationCard({ operationName }: { operationName: string }) {
  return (
    <div
      className="scan-card scan-card--simple"
      aria-label="Смена не на упаковке"
    >
      <h2 className="scan-card__title">
        <Icon name="warning" size={22} />
        <span style={{ marginLeft: '0.45rem' }}>Смена не на упаковке</span>
      </h2>
      <p className="scan-card__hint">
        Текущая операция — <strong>{operationName}</strong>. Чтобы
        упаковывать, завершите смену через меню в правом верхнем углу и
        начните новую на оборудовании упаковки.
      </p>
    </div>
  );
}

interface MainProps {
  shift: ShiftSessionDto;
  initialOpenBoxes: BoxListItemDto[];
  initialClosedUnplacedBoxes: BoxListItemDto[];
}

function PackingMainTerminal({
  shift,
  initialOpenBoxes,
  initialClosedUnplacedBoxes,
}: MainProps) {
  const [box, setBox] = useState<BoxDetailDto | null>(null);
  // Локальный кеш списка `OPEN` коробок: первый рендер берёт SSR-снимок,
  // дальше обновляется client-action'ом (`refreshOpenBoxes`) после
  // закрытия коробки и при ручном refresh.
  const [openBoxes, setOpenBoxes] =
    useState<BoxListItemDto[]>(initialOpenBoxes);
  const [openBoxesLoading, setOpenBoxesLoading] = useState(false);
  // Локальный кеш «закрытых, но ещё не размещённых» коробок. После
  // успешного `placeBoxTerminalAction` коробка из списка убирается
  // оптимистично (без ожидания backend round-trip), а параллельно
  // происходит refresh на случай несинхронных правок коллег.
  const [closedUnplacedBoxes, setClosedUnplacedBoxes] = useState<
    BoxListItemDto[]
  >(initialClosedUnplacedBoxes);
  const [closedUnplacedLoading, setClosedUnplacedLoading] = useState(false);
  // id коробки, у которой сейчас открыт сканер ячейки для размещения
  // (mutually exclusive с обычным сканером паспортов на Stage 2).
  const [placingBoxId, setPlacingBoxId] = useState<string | null>(null);
  const [placingBoxNumber, setPlacingBoxNumber] = useState<string | null>(null);
  const [placeManualOpen, setPlaceManualOpen] = useState(false);
  const [placeManualCode, setPlaceManualCode] = useState('');
  // Id коробки, которую упаковщик «свернул», но **не закрыл**: она
  // ещё `OPEN` в БД. Нужен, чтобы на пустом stage показать баннер
  // «Карточка свёрнута» с кнопкой возврата и не дать упаковщику
  // потерять активную коробку (см. docs/packing-close-ui-recon.md §6).
  const [collapsedBoxId, setCollapsedBoxId] = useState<string | null>(null);
  // Сворачивание секций списка «Открытые коробки» и «Ждут размещения»
  // на Stage 1. По умолчанию свёрнуто, в шапке остаётся счётчик и
  // кнопка обновления — упаковщик видит масштаб и при желании
  // разворачивает. Состояние не сохраняется между сессиями: каждый
  // вход в терминал стартует с чистого свёрнутого вида, чтобы primary-
  // action «Создать коробку» был виден сразу.
  const [openBoxesCollapsed, setOpenBoxesCollapsed] = useState(true);
  const [closedUnplacedCollapsed, setClosedUnplacedCollapsed] =
    useState(true);
  // Подпись свёрнутой коробки для баннера — чтобы не делать ещё один
  // запрос только ради номера. Заполняется одновременно с `collapsedBoxId`.
  const [collapsedBoxNumber, setCollapsedBoxNumber] = useState<string | null>(
    null,
  );
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState<ErrorState | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Свежесть последнего скана: подсвечиваем «✓ только что добавлен».
  // Сбрасывается на следующий скан / на смену коробки.
  const [lastAddedPassportId, setLastAddedPassportId] = useState<string | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();
  const restoredRef = useRef(false);

  // Восстанавливаем активную коробку из localStorage, если страница
  // перезагрузилась. fail-soft: если id невалиден или коробка уже
  // закрыта — просто чистим storage и стартуем с пустого state.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (typeof window === 'undefined') return;
    let savedId: string | null = null;
    try {
      savedId = window.localStorage.getItem(ACTIVE_BOX_STORAGE_KEY);
    } catch {
      return;
    }
    if (!savedId) return;
    void (async () => {
      const res = await getActiveBoxAction(savedId);
      if (!res.ok) {
        try {
          window.localStorage.removeItem(ACTIVE_BOX_STORAGE_KEY);
        } catch {
          /* fail-soft */
        }
        return;
      }
      if (res.data.status === 'CLOSED') {
        try {
          window.localStorage.removeItem(ACTIVE_BOX_STORAGE_KEY);
        } catch {
          /* fail-soft */
        }
        return;
      }
      setBox(res.data);
    })();
  }, []);

  // Сохраняем id активной коробки в localStorage при каждой смене.
  // «Активной» считается либо открытая коробка в state, либо
  // свернутая (`collapsedBoxId`) — она ещё `OPEN` в БД, и упаковщик
  // должен иметь возможность вернуться к ней после перезагрузки.
  // Закрытая коробка (`status === 'CLOSED'`) активной не считается —
  // её id из storage чистится.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const remembered =
        box && box.status === 'OPEN' ? box.id : collapsedBoxId;
      if (remembered) {
        window.localStorage.setItem(ACTIVE_BOX_STORAGE_KEY, remembered);
      } else {
        window.localStorage.removeItem(ACTIVE_BOX_STORAGE_KEY);
      }
    } catch {
      /* fail-soft */
    }
  }, [box, collapsedBoxId]);

  const handleCreateBox = () => {
    setError(null);
    setInfo(null);
    setLastAddedPassportId(null);
    startTransition(async () => {
      const res = await createBoxTerminalAction();
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      setBox(res.data);
      setInfo(`Коробка ${res.data.number} открыта. Сканируйте паспорта.`);
    });
  };

  const acceptScan = (code: string) => {
    if (!box) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setError({ message: 'Введите или отсканируйте код паспорта' });
      return;
    }
    setError(null);
    setInfo(null);
    const boxId = box.id;
    startTransition(async () => {
      const res = await scanPassportToBoxAction(boxId, trimmed);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      // Подсвечиваем последний добавленный паспорт: вычисляем diff
      // по `items` старой и новой карточки.
      const prevIds = new Set(box.items.map((it) => it.passportId));
      const justAdded = res.data.items.find(
        (it) => !prevIds.has(it.passportId),
      );
      setBox(res.data);
      setLastAddedPassportId(justAdded?.passportId ?? null);
      setManualCode('');
      setManualOpen(false);
      playCutAcceptedSound();
      setInfo(
        justAdded
          ? `Паспорт ${justAdded.passportNumber} упакован. В коробке ${res.data.totalQty} шт.`
          : `Паспорт уже был в коробке. ${res.data.totalQty} шт.`,
      );
    });
  };

  const handleScan = (decoded: string) => {
    setScannerOpen(false);
    // Если активен flow «разместить коробку в ячейку» — общий
    // QR-сканер уходит туда, а не в добавление паспорта.
    if (placingBoxId) {
      acceptPlacementCode(decoded);
      return;
    }
    acceptScan(decoded);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    acceptScan(manualCode);
  };

  const handlePlacementManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    acceptPlacementCode(placeManualCode);
  };

  const handleClose = () => {
    if (!box || box.status !== 'OPEN') return;
    if (box.totalQty <= 0) {
      setError({ message: 'Нельзя закрыть пустую коробку' });
      return;
    }
    const boxId = box.id;
    setError(null);
    startTransition(async () => {
      const res = await closeBoxTerminalAction(boxId);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      playOperationCompletedSound();
      setInfo(
        `Коробка ${res.data.number} закрыта. Начислено всем участникам.`,
      );
      // Оставляем закрытую коробку в state — рендерим success-карточку
      // с явным статусом «Закрыта» и ссылкой на детальную страницу.
      // См. `docs/packing-close-ui-recon.md §7`.
      setBox(res.data);
      setCollapsedBoxId(null);
      setCollapsedBoxNumber(null);
      setLastAddedPassportId(null);
      setManualCode('');
      setManualOpen(false);
      // После закрытия — список незакрытых коробок устаревает (только
      // что закрытая должна исчезнуть; коллеги могли открыть/закрыть
      // свои). Перечитываем backend, чтобы Stage 1 после «Создать
      // новую коробку» показал актуальный пул.
      refreshOpenBoxes();
    });
  };

  const handleStartNewBox = () => {
    setBox(null);
    setLastAddedPassportId(null);
    setError(null);
    setInfo(null);
    setManualCode('');
    setManualOpen(false);
  };

  const handleRefresh = () => {
    if (!box) return;
    const id = box.id;
    startTransition(async () => {
      const res = await getActiveBoxAction(id);
      if (!res.ok) return;
      setBox(res.data);
    });
  };

  const refreshOpenBoxes = () => {
    setOpenBoxesLoading(true);
    startTransition(async () => {
      const res = await listOpenBoxesTerminalAction();
      setOpenBoxesLoading(false);
      if (!res.ok) return;
      setOpenBoxes(res.data);
    });
  };

  const refreshClosedUnplacedBoxes = () => {
    setClosedUnplacedLoading(true);
    startTransition(async () => {
      const res = await listClosedUnplacedBoxesTerminalAction();
      setClosedUnplacedLoading(false);
      if (!res.ok) return;
      setClosedUnplacedBoxes(res.data);
    });
  };

  const handleStartPlacement = (id: string, number: string) => {
    setError(null);
    setInfo(null);
    setPlacingBoxId(id);
    setPlacingBoxNumber(number);
    setPlaceManualOpen(false);
    setPlaceManualCode('');
    // Открываем общий QR-сканер сразу — упаковщик ожидаемо сразу
    // подносит QR ячейки. Альтернативный «ручной ввод» включается
    // отдельной кнопкой ниже на той же карточке.
    setScannerOpen(true);
  };

  const handleCancelPlacement = () => {
    setPlacingBoxId(null);
    setPlacingBoxNumber(null);
    setPlaceManualOpen(false);
    setPlaceManualCode('');
    setScannerOpen(false);
  };

  const acceptPlacementCode = (code: string) => {
    if (!placingBoxId) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setError({ message: 'Введите или отсканируйте код ячейки' });
      return;
    }
    const id = placingBoxId;
    setError(null);
    startTransition(async () => {
      const res = await placeBoxTerminalAction(id, trimmed);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      // Оптимистично выкидываем коробку из списка «ждут размещения»;
      // параллельно делаем refresh — на случай, если коллеги тоже
      // что-то двигали.
      setClosedUnplacedBoxes((prev) => prev.filter((b) => b.id !== id));
      refreshClosedUnplacedBoxes();
      const cellCode = res.data.placedInCell?.code ?? '—';
      setInfo(
        `Коробка ${res.data.number} размещена в ячейку ${cellCode}.`,
      );
      setPlacingBoxId(null);
      setPlacingBoxNumber(null);
      setPlaceManualOpen(false);
      setPlaceManualCode('');
    });
  };

  const handlePickOpenBox = (id: string) => {
    setError(null);
    setInfo(null);
    setLastAddedPassportId(null);
    startTransition(async () => {
      const res = await getActiveBoxAction(id);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        return;
      }
      if (res.data.status === 'CLOSED') {
        // Коллега успел закрыть, пока упаковщик смотрел список —
        // обновим список и не открываем закрытую как активную.
        setInfo(`Коробка ${res.data.number} уже закрыта.`);
        refreshOpenBoxes();
        return;
      }
      setBox(res.data);
      setCollapsedBoxId(null);
      setCollapsedBoxNumber(null);
    });
  };

  const handleLeaveBox = () => {
    if (!box || box.status !== 'OPEN') return;
    // Коробка ещё `OPEN` в БД — запоминаем её id, чтобы показать
    // на пустом stage баннер «Карточка свёрнута» с кнопкой возврата.
    // localStorage сохраняется автоматически (см. effect выше).
    setCollapsedBoxId(box.id);
    setCollapsedBoxNumber(box.number);
    setBox(null);
    setLastAddedPassportId(null);
    setError(null);
    setInfo(
      `Карточка коробки ${box.number} свёрнута. Коробка ещё открыта — её можно вернуть кнопкой ниже.`,
    );
    setManualCode('');
    setManualOpen(false);
  };

  const handleRestoreCollapsedBox = () => {
    if (!collapsedBoxId) return;
    const id = collapsedBoxId;
    setError(null);
    startTransition(async () => {
      const res = await getActiveBoxAction(id);
      if (!res.ok) {
        setError({ message: res.error, requestId: res.errorRequestId });
        setCollapsedBoxId(null);
        setCollapsedBoxNumber(null);
        return;
      }
      if (res.data.status === 'CLOSED') {
        // Кто-то закрыл коробку с другого устройства, пока мы были
        // на пустом stage. Покажем закрытую карточку — ровно тот же
        // success state, что после собственного close.
        setBox(res.data);
        setCollapsedBoxId(null);
        setCollapsedBoxNumber(null);
        setInfo(`Коробка ${res.data.number} уже закрыта.`);
        return;
      }
      setBox(res.data);
      setCollapsedBoxId(null);
      setCollapsedBoxNumber(null);
      setInfo(null);
    });
  };

  // ----------------------------------------------------------------------
  // Stage 1: нет активной коробки — большая кнопка «Создать коробку».
  // Дополнительно — баннер «Карточка свёрнута», если у нас в state
  // запомнен collapsedBoxId: коробка ещё `OPEN` в БД, и упаковщик
  // должен иметь явный путь к ней (см. docs/packing-close-ui-recon.md §6).
  // ----------------------------------------------------------------------
  if (!box) {
    // Свёрнутая коробка показывается отдельным баннером выше — чтобы
    // не дублировать её внутри списка «Открытые коробки», убираем по
    // id. Закрытые в backend-фильтре `?status=OPEN` не приходят.
    const visibleOpenBoxes = openBoxes.filter(
      (b) => b.id !== collapsedBoxId,
    );
    return (
      <>
        <ShiftStrip startedAt={shift.startedAt} />

        {collapsedBoxId && (
          <div
            className="scan-card scan-card--simple"
            aria-label="Свёрнутая коробка"
            style={{ marginBottom: '0.75rem' }}
          >
            <h2 className="scan-card__title">
              <Icon name="packing" size={22} />
              <span style={{ marginLeft: '0.45rem' }}>
                Коробка{collapsedBoxNumber ? ` ${collapsedBoxNumber}` : ''}{' '}
                свёрнута
              </span>
            </h2>
            <p className="scan-card__hint">
              Карточка свёрнута, но сама коробка ещё открыта в системе.
              Можно вернуться к ней и продолжить упаковку.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={handleRestoreCollapsedBox}
              disabled={isPending}
            >
              {isPending ? 'Загружаем…' : 'Вернуться к коробке'}
            </button>
          </div>
        )}

        {/*
         * Primary-action «Создать коробку» — самый верхний блок Stage 1
         * (выше списков «Открытые коробки» и «Ждут размещения»).
         * Размещение: сразу после баннера «Карточка свёрнута» (он
         * сильнее как CTA: вернуться к МОЕЙ начатой коробке), но
         * раньше списков чужих коробок. Списки ниже свёрнуты по
         * умолчанию — упаковщик при необходимости раскроет.
         */}
        <div
          className="scan-card scan-card--simple"
          aria-label="Создать коробку"
          style={{ marginBottom: '0.75rem' }}
        >
          <div>
            <h2 className="scan-card__title">
              <Icon name="packing" size={22} />
              <span style={{ marginLeft: '0.45rem' }}>Новая коробка</span>
            </h2>
            <p className="scan-card__hint">
              Откройте коробку — затем сканируйте паспорта. По умолчанию
              рекомендуем лимит 100 шт.; можно задать другой, если
              коробка нестандартная. Содержимое должно быть однородным
              (одинаковое изделие, цвет и размер).
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
            className="btn btn-primary btn-lg btn-block"
            onClick={handleCreateBox}
            disabled={isPending}
          >
            {isPending ? 'Создаём…' : 'Создать коробку'}
          </button>
        </div>

        {visibleOpenBoxes.length > 0 && (
          <section
            className="scan-card scan-card--simple packing-open-boxes"
            aria-label="Открытые коробки"
            style={{ marginBottom: '0.75rem' }}
          >
            <header
              className="packing-open-boxes__header"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
              }}
            >
              <button
                type="button"
                onClick={() => setOpenBoxesCollapsed((v) => !v)}
                aria-expanded={!openBoxesCollapsed}
                aria-controls="packing-open-boxes-body"
                className="packing-section-toggle"
              >
                <span className="packing-section-toggle__caret" aria-hidden>
                  {openBoxesCollapsed ? '▸' : '▾'}
                </span>
                <h2 className="scan-card__title" style={{ margin: 0 }}>
                  <Icon name="packing" size={22} />
                  <span style={{ marginLeft: '0.45rem' }}>
                    Открытые коробки ({visibleOpenBoxes.length})
                  </span>
                </h2>
              </button>
              <button
                type="button"
                className="scan-card__manual-toggle"
                onClick={refreshOpenBoxes}
                disabled={openBoxesLoading || isPending}
              >
                {openBoxesLoading ? 'Обновляем…' : 'Обновить'}
              </button>
            </header>
            {!openBoxesCollapsed && (
              <>
            <p className="scan-card__hint">
              Все незакрытые коробки. Нажмите «Продолжить» — карточка
              откроется, можно сканировать паспорта или закрыть.
            </p>
            <ul
              id="packing-open-boxes-body"
              className="packing-open-boxes__list"
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              {visibleOpenBoxes.map((b) => (
                <li
                  key={b.id}
                  className="packing-open-boxes__item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    padding: '0.6rem 0.75rem',
                    border: '1px solid var(--color-border, #e4e4e1)',
                    borderRadius: '0.5rem',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <strong>{b.number}</strong>
                    <div className="meta-line" style={{ margin: 0 }}>
                      {b.summary
                        ? `${b.summary.productName} · ${b.summary.color} · ${b.summary.sizeCode}`
                        : 'Пустая коробка · ждёт первый паспорт'}
                    </div>
                    <div className="meta-line" style={{ margin: 0 }}>
                      {b.totalQty} шт. · {b.itemsCount} паспорт(ов)
                      {b.createdByName ? ` · ${b.createdByName}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handlePickOpenBox(b.id)}
                    disabled={isPending}
                  >
                    Продолжить
                  </button>
                </li>
              ))}
            </ul>
              </>
            )}
          </section>
        )}

        {closedUnplacedBoxes.length > 0 && (
          <section
            className="scan-card scan-card--simple packing-unplaced-boxes"
            aria-label="Упакованы — ждут размещения"
            style={{ marginBottom: '0.75rem' }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
              }}
            >
              <button
                type="button"
                onClick={() => setClosedUnplacedCollapsed((v) => !v)}
                aria-expanded={!closedUnplacedCollapsed}
                aria-controls="packing-unplaced-boxes-body"
                className="packing-section-toggle"
              >
                <span className="packing-section-toggle__caret" aria-hidden>
                  {closedUnplacedCollapsed ? '▸' : '▾'}
                </span>
                <h2 className="scan-card__title" style={{ margin: 0 }}>
                  <Icon name="packing" size={22} />
                  <span style={{ marginLeft: '0.45rem' }}>
                    Ждут размещения ({closedUnplacedBoxes.length})
                  </span>
                </h2>
              </button>
              <button
                type="button"
                className="scan-card__manual-toggle"
                onClick={refreshClosedUnplacedBoxes}
                disabled={closedUnplacedLoading || isPending}
              >
                {closedUnplacedLoading ? 'Обновляем…' : 'Обновить'}
              </button>
            </header>
            {!closedUnplacedCollapsed && (
              <>
            <p className="scan-card__hint">
              Закрытые коробки, которые ещё не размещены в ячейку.
              Нажмите «Разместить» и отсканируйте QR ячейки склада.
            </p>
            <ul
              id="packing-unplaced-boxes-body"
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              {closedUnplacedBoxes.map((b) => {
                const isPlacingThis = placingBoxId === b.id;
                return (
                  <li
                    key={b.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      padding: '0.6rem 0.75rem',
                      border: '1px solid var(--color-border, #e4e4e1)',
                      borderRadius: '0.5rem',
                      background: isPlacingThis
                        ? 'var(--color-bg-soft, #f7f7f6)'
                        : undefined,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <strong>{b.number}</strong>
                        <div className="meta-line" style={{ margin: 0 }}>
                          {b.summary
                            ? `${b.summary.productName} · ${b.summary.color} · ${b.summary.sizeCode}`
                            : 'Пустая коробка'}
                        </div>
                        <div className="meta-line" style={{ margin: 0 }}>
                          {b.totalQty} шт. · {b.itemsCount} паспорт(ов)
                          {b.closedAt
                            ? ` · закрыта ${formatTime(b.closedAt)}`
                            : ''}
                          {b.createdByName ? ` · ${b.createdByName}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <a
                          className="btn"
                          href={`/api/packing/boxes/${encodeURIComponent(b.id)}/label`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Этикетка
                        </a>
                        {!isPlacingThis ? (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleStartPlacement(b.id, b.number)}
                            disabled={isPending}
                          >
                            Разместить
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn"
                            onClick={handleCancelPlacement}
                            disabled={isPending}
                          >
                            Отмена
                          </button>
                        )}
                      </div>
                    </div>
                    {isPlacingThis && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.5rem',
                        }}
                      >
                        <p className="meta-line" style={{ margin: 0 }}>
                          Отсканируйте QR ячейки склада, куда вы кладёте
                          коробку <strong>{placingBoxNumber}</strong>.
                        </p>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => {
                              setError(null);
                              setScannerOpen(true);
                            }}
                            disabled={isPending}
                          >
                            <Icon name="scan" size={18} />
                            <span style={{ marginLeft: '0.4rem' }}>
                              Сканировать ячейку
                            </span>
                          </button>
                          <button
                            type="button"
                            className="scan-card__manual-toggle"
                            onClick={() => setPlaceManualOpen((v) => !v)}
                          >
                            {placeManualOpen
                              ? 'Скрыть ручной ввод'
                              : 'Ввести код вручную'}
                          </button>
                        </div>
                        {placeManualOpen && (
                          <form
                            onSubmit={handlePlacementManualSubmit}
                            aria-label="Ввести код ячейки вручную"
                            className="seamstress-start__manual"
                          >
                            <label
                              className="scan-card__input"
                              htmlFor={`packing-place-cell-${b.id}`}
                            >
                              <span className="scan-card__input-label">
                                Код ячейки
                              </span>
                              <input
                                id={`packing-place-cell-${b.id}`}
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                autoCapitalize="off"
                                autoCorrect="off"
                                spellCheck={false}
                                placeholder="cell:… / код ячейки"
                                value={placeManualCode}
                                onChange={(e) =>
                                  setPlaceManualCode(e.target.value)
                                }
                                autoFocus
                              />
                            </label>
                            <button
                              type="submit"
                              className="btn btn-block"
                              disabled={isPending}
                            >
                              Разместить в ячейку
                            </button>
                          </form>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
              </>
            )}
          </section>
        )}

      </>
    );
  }

  // ----------------------------------------------------------------------
  // Stage 2a: коробка только что закрыта — show success-карточку с
  // явным статусом «Закрыта», ссылкой на детальную страницу и
  // primary-кнопкой «Создать новую коробку». См.
  // `docs/packing-close-ui-recon.md §7`.
  // ----------------------------------------------------------------------
  if (box.status === 'CLOSED') {
    return (
      <>
        <ShiftStrip startedAt={shift.startedAt} />

        <section className="qc-card" aria-label="Закрытая коробка">
          <header className="qc-card__header">
            <div>
              <div className="qc-card__label">Коробка</div>
              <div className="qc-card__number">{box.number}</div>
            </div>
            <span className="status-badge done">Закрыта</span>
          </header>

          <dl className="qc-card__grid">
            <div>
              <dt>Изделие</dt>
              <dd>{box.summary?.productName ?? '—'}</dd>
            </div>
            <div>
              <dt>Цвет</dt>
              <dd>{box.summary?.color ?? '—'}</dd>
            </div>
            <div>
              <dt>Размер</dt>
              <dd className="qc-card__size">{box.summary?.sizeCode ?? '—'}</dd>
            </div>
            <div>
              <dt>Упаковано</dt>
              <dd>
                <strong>{box.totalQty}</strong> шт.
              </dd>
            </div>
          </dl>

          {info && (
            <div className="info-box" role="status">
              {info}
            </div>
          )}

          {box.items.length > 0 && (
            <details className="qc-card__history">
              <summary>Упаковано: {box.items.length} паспорт(ов)</summary>
              <ul>
                {box.items.map((it) => (
                  <li key={it.id}>
                    <strong>{it.passportNumber}</strong> · {it.qty} шт.
                    <span className="qc-card__history-meta">
                      {' '}
                      · заказ {it.orderNumber} · {formatTime(it.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="qc-card__actions">
            <a
              className="btn btn-success btn-block btn-lg"
              href={box.labelUrl}
              target="_blank"
              rel="noreferrer"
            >
              Печать наклейки
            </a>
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg"
              onClick={handleStartNewBox}
              disabled={isPending}
            >
              Создать новую коробку
            </button>
            <Link
              className="btn btn-block"
              href={`/packing/boxes/${box.id}`}
            >
              Открыть карточку коробки
            </Link>
          </div>
        </section>
      </>
    );
  }

  // ----------------------------------------------------------------------
  // Stage 2: коробка открыта — показываем карточку + сканирование.
  // ----------------------------------------------------------------------

  return (
    <>
      <ShiftStrip startedAt={shift.startedAt} />

      <section className="qc-card" aria-label="Активная коробка">
        <header className="qc-card__header">
          <div>
            <div className="qc-card__label">Коробка</div>
            <div className="qc-card__number">{box.number}</div>
          </div>
          <span className="status-badge in_production">Открыта</span>
        </header>

        <dl className="qc-card__grid">
          <div>
            <dt>Изделие</dt>
            <dd>{box.summary?.productName ?? '—'}</dd>
          </div>
          <div>
            <dt>Цвет</dt>
            <dd>{box.summary?.color ?? '—'}</dd>
          </div>
          <div>
            <dt>Размер</dt>
            <dd className="qc-card__size">{box.summary?.sizeCode ?? '—'}</dd>
          </div>
          <div>
            <dt>Упаковано</dt>
            <dd>
              <strong>{box.totalQty}</strong> шт.
            </dd>
          </div>
        </dl>

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
              htmlFor="packing-passport-code"
            >
              <span className="scan-card__input-label">Код паспорта</span>
              <input
                id="packing-passport-code"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="P-… / passport:… / id"
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
              Упаковать паспорт
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

        {box.items.length === 0 ? (
          <div className="card empty qc-card__defect-empty">
            В коробке пока нет паспортов. Отсканируйте первый — карточка
            обновится автоматически.
          </div>
        ) : (
          <details className="qc-card__history" open>
            <summary>Упаковано: {box.items.length} паспорт(ов)</summary>
            <ul>
              {box.items.map((it) => {
                const isFresh = it.passportId === lastAddedPassportId;
                return (
                  <li key={it.id}>
                    <strong>{it.passportNumber}</strong> · {it.qty} шт.
                    <span className="qc-card__history-meta">
                      {' '}
                      · заказ {it.orderNumber} · {formatTime(it.createdAt)}
                    </span>
                    {isFresh && (
                      <span
                        className="status-badge done"
                        style={{ marginLeft: '0.5rem' }}
                      >
                        ✓ только что
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        <div className="qc-card__actions">
          <button
            type="button"
            className="btn btn-success btn-block btn-lg"
            onClick={handleClose}
            disabled={isPending || box.totalQty <= 0}
          >
            {isPending
              ? 'Сохраняем…'
              : box.totalQty <= 0
                ? 'Закрыть коробку (пусто)'
                : `Закрыть коробку (${box.totalQty} шт.)`}
          </button>
          <button
            type="button"
            className="btn btn-block"
            onClick={handleLeaveBox}
            disabled={isPending}
          >
            Свернуть карточку
          </button>
          <button
            type="button"
            className="scan-card__manual-toggle"
            onClick={handleRefresh}
            disabled={isPending}
          >
            Обновить карточку
          </button>
        </div>
      </section>

      {scannerOpen && (
        <QrScannerModal
          onScan={handleScan}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </>
  );
}

function ShiftStrip({ startedAt }: { startedAt: string }) {
  return (
    <p className="meta-line" style={{ margin: '0 0 0.5rem' }}>
      Смена на упаковке с <strong>{formatTime(startedAt)}</strong>
    </p>
  );
}
