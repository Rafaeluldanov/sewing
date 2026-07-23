'use client';

/**
 * Клиентская часть мобильного экрана `/master` (см. также server-комп
 * `apps/web/app/master/page.tsx`).
 *
 * Отвечает за:
 *   1) periodic polling очереди открытых вызовов
 *      (`refreshOpenMasterCallsAction`, шаг 5 секунд) — без WebSocket'ов
 *      и пока без оптимистичных обновлений, чтобы MVP остался простым;
 *   2) расчёт «ожидает N мин/сек» на клиенте (тот же подход, что у
 *      часов `/shopfloor/display`) — таймер тикает раз в секунду;
 *   3) запуск камеры через общий `QrScannerModal` и закрытие вызова
 *      по сканированному `EMPLOYEE:<id>`.
 *
 * Mobile-first:
 *   - крупные карточки вместо таблицы;
 *   - крупная кнопка «Сканировать QR сотрудника» в каждой карточке —
 *     удобно одной рукой;
 *   - короткий success-toast «Вызов закрыт» внизу экрана.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseEmployeeQr,
  type MasterCallDto,
  type MasterCallPassportDto,
} from '@sewing/shared/master-calls';
import type { CutReleasePolicyDto, SizeDto } from '@sewing/shared';
import type { DefectTypeDto } from '@sewing/shared/qc';
import type { PassportQtyCorrectionDto } from '@sewing/shared/passport-qty-corrections';
import { Icon } from '@/components/icon';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { RoleHeaderCard } from '@/components/role-header-card';
import { SeamstressActionsMenu } from '@/app/work/seamstress-actions-menu';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  refreshOpenMasterCallsAction,
  refreshRecentlyResolvedMasterCallsAction,
  resolveMasterCallByEmployeeQrAction,
  resolveMasterCallByIdAction,
} from './actions';
import { findMasterPassportByCodeAction } from './master-actions-actions';
import { PassportActionsSheet } from './passport-actions-sheet';
import { CutReleasePolicyCard } from './cut-release-policy-card';
import { refreshCutReleasePolicyAction } from './cut-release-policy-actions';
import { ProductionBoardView } from './production-board-view';
import { EmployeeStatsView } from './employee-stats-view';
import { QtyCorrectionsView } from './qty-corrections-view';
import {
  approveQtyCorrectionAction,
  refreshPendingQtyCorrectionsAction,
  rejectQtyCorrectionAction,
} from './qty-corrections-actions';

const POLL_INTERVAL_MS = 5000;

interface Props {
  initialItems: MasterCallDto[];
  initialError: string | null;
  initialResolved: MasterCallDto[];
  initialPolicy: CutReleasePolicyDto | null;
  sizes: SizeDto[];
  /** Справочник видов брака для ОТК-действий мастера в PassportActionsSheet. */
  defectTypes: DefectTypeDto[];
  /**
   * Показывать ли кнопку «Мой QR-код» (роль прошла
   * `canSeeEmployeeQrButton`). Гейт считается на сервере в `page.tsx`.
   */
  showEmployeeQr: boolean;
  /** Имя мастера для синей шапки-профиля `RoleHeaderCard`. */
  fullName: string;
  /** Фича «Корректировка количества» (флаг `FEATURE_QTY_CORRECTION`). */
  qtyCorrectionEnabled: boolean;
  /** SSR-снимок очереди открытых корректировок (для вкладки/бейджа). */
  initialQtyCorrections: PassportQtyCorrectionDto[];
}

export function MasterPageClient({
  initialItems,
  initialError,
  initialResolved,
  initialPolicy,
  sizes,
  defectTypes,
  showEmployeeQr,
  fullName,
  qtyCorrectionEnabled,
  initialQtyCorrections,
}: Props) {
  const [items, setItems] = useState<MasterCallDto[]>(initialItems);
  const [resolved, setResolved] =
    useState<MasterCallDto[]>(initialResolved);
  const [error, setError] = useState<string | null>(initialError);
  const [policy, setPolicy] = useState<CutReleasePolicyDto | null>(
    initialPolicy,
  );
  // `scannerMode === 'employee'` — закрытие конкретного вызова QR'ом
  // сотрудника (исторический сценарий). `'passport'` — новая кнопка
  // «Сканировать паспорт»: мастер сканирует ЛЮБОЙ паспорт и получает
  // те же действия, что в карточке вызова. `null` — сканер закрыт.
  const [scannerMode, setScannerMode] = useState<
    null | 'employee' | 'passport'
  >(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [findingPassport, setFindingPassport] = useState(false);
  const [resolvingManualId, setResolvingManualId] = useState<string | null>(
    null,
  );
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Вкладки кабинета мастера: очередь вызовов (исторический экран),
  // «Движение тиража» (доска по дате выдачи кроя), «Сотрудники» и
  // «Корректировки» (заявки ОТК на правку количества).
  const [tab, setTab] = useState<
    'calls' | 'board' | 'employees' | 'corrections'
  >('calls');
  const [corrections, setCorrections] = useState<PassportQtyCorrectionDto[]>(
    initialQtyCorrections,
  );
  const [busyCorrectionId, setBusyCorrectionId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  // Stage 2 «Действия мастера»: открытый bottom-sheet ручных действий
  // над одним паспортом. `ownerName` подсказываем подписью «На сотруднике»,
  // чтобы мастер физически видел, у кого паспорт сейчас (карточка вызова
  // могла переместиться при polling'е).
  const [actionsFor, setActionsFor] = useState<{
    passport: MasterCallPassportDto;
    ownerName: string;
  } | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const res = await refreshOpenMasterCallsAction();
    if (res.ok) {
      setItems(res.items);
      setError(null);
    } else {
      setError(res.error);
    }
    // Архив (последние закрытые вызовы) обновляем тем же polling'ом —
    // другой мастер мог закрыть вызов с другого устройства. Soft-fail:
    // ошибки не показываем, чтобы не перекрывать экран активных вызовов.
    const arcRes = await refreshRecentlyResolvedMasterCallsAction();
    if (arcRes.ok) {
      setResolved(arcRes.items);
    }
    // Stage 3 «Мастер цеха»: политика выдачи кроя обновляется тем
    // же polling'ом, чтобы карточка показывала актуальный
    // `consumedQty / limitQty` без отдельного интервала. Ошибки тут
    // не показываем — основной экран мастера это вызовы; если API
    // policy недоступен, пользователь увидит «протухший» снимок,
    // что лучше пустого экрана.
    const polRes = await refreshCutReleasePolicyAction();
    if (polRes.ok) {
      setPolicy(polRes.policy);
    }
    // Очередь корректировок количества (если фича включена) — тем же
    // polling'ом, чтобы бейдж вкладки и список были живыми. Soft-fail.
    if (qtyCorrectionEnabled) {
      const corrRes = await refreshPendingQtyCorrectionsAction();
      if (corrRes.ok) {
        setCorrections(corrRes.items);
      }
    }
  }, [qtyCorrectionEnabled]);

  // Список цветов для datalist в форме ограничения. Берём из
  // currentPassports открытых вызовов мастера — это всё, что у нас
  // есть «бесплатно» на клиенте; справочник цветов на MVP отдельно
  // не ведётся.
  const knownColors = useMemo(() => {
    const set = new Set<string>();
    for (const c of items) {
      for (const p of c.currentPassports) {
        if (p.color) set.add(p.color);
      }
    }
    return Array.from(set).sort();
  }, [items]);

  useEffect(() => {
    pollTimerRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    tickTimerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (tickTimerRef.current) clearInterval(tickTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [refresh]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const onApproveCorrection = useCallback(
    async (id: string) => {
      if (busyCorrectionId) return;
      setBusyCorrectionId(id);
      setError(null);
      try {
        const res = await approveQtyCorrectionAction(id);
        if (res.ok) {
          setCorrections((prev) => prev.filter((c) => c.id !== id));
          const skipped = res.result.salarySkipped;
          showToast(
            `Корректировка применена: годных ${res.result.qtyGood}` +
              (skipped > 0
                ? `. ${skipped} строк ЗП уже выплачены — разберите вручную.`
                : ''),
          );
        } else {
          setError(res.error);
        }
      } finally {
        setBusyCorrectionId(null);
        void refresh();
      }
    },
    [busyCorrectionId, refresh, showToast],
  );

  const onRejectCorrection = useCallback(
    async (id: string) => {
      if (busyCorrectionId) return;
      if (
        typeof window !== 'undefined' &&
        !window.confirm('Отклонить корректировку количества?')
      ) {
        return;
      }
      setBusyCorrectionId(id);
      setError(null);
      try {
        const res = await rejectQtyCorrectionAction(id);
        if (res.ok) {
          setCorrections((prev) => prev.filter((c) => c.id !== id));
          showToast('Корректировка отклонена');
        } else {
          setError(res.error);
        }
      } finally {
        setBusyCorrectionId(null);
        void refresh();
      }
    },
    [busyCorrectionId, refresh, showToast],
  );

  const onOpenScanner = useCallback((callId: string) => {
    setActiveCallId(callId);
    setError(null);
    setScannerMode('employee');
  }, []);

  const onOpenPassportScanner = useCallback(() => {
    setError(null);
    setScannerMode('passport');
  }, []);

  const onCloseScanner = useCallback(() => {
    setScannerMode(null);
    setActiveCallId(null);
  }, []);

  const onResolveManual = useCallback(
    async (callId: string) => {
      if (resolvingManualId) return;
      setResolvingManualId(callId);
      setError(null);
      try {
        const res = await resolveMasterCallByIdAction(callId);
        if (res.ok) {
          // Оптимистично переносим карточку в архив, чтобы UX был
          // мгновенным — polling следом синхронизирует серверное состояние.
          setItems((prev) => prev.filter((c) => c.id !== callId));
          setResolved((prev) => [res.call, ...prev].slice(0, 50));
          showToast('Вызов закрыт');
        } else {
          setError(res.error);
        }
      } finally {
        setResolvingManualId(null);
        void refresh();
      }
    },
    [refresh, resolvingManualId, showToast],
  );

  const onScan = useCallback(
    async (decodedText: string) => {
      // Ветка «Сканировать паспорт» — открываем PassportActionsSheet
      // с найденным паспортом, не трогаем очередь вызовов.
      if (scannerMode === 'passport') {
        if (findingPassport) return;
        setFindingPassport(true);
        setScannerMode(null);
        try {
          const res = await findMasterPassportByCodeAction({
            code: decodedText,
          });
          if (res.ok) {
            setActionsFor({
              passport: res.result.passport,
              ownerName: res.result.ownerFullName ?? 'Не закреплён',
            });
            setError(null);
          } else {
            setError(res.error);
          }
        } finally {
          setFindingPassport(false);
        }
        return;
      }

      // Историческая ветка — закрытие вызова по QR сотрудника.
      if (resolving) return;
      const parsed = parseEmployeeQr(decodedText);
      if (!parsed) {
        setScannerMode(null);
        setActiveCallId(null);
        setError('QR не распознан как сотрудник (ожидается EMPLOYEE:<id>)');
        return;
      }
      setResolving(true);
      setScannerMode(null);
      try {
        const res = await resolveMasterCallByEmployeeQrAction(decodedText);
        if (res.ok) {
          setItems((prev) => prev.filter((c) => c.employee.id !== parsed));
          showToast('Вызов закрыт');
          setError(null);
        } else {
          setError(res.error);
        }
      } finally {
        setResolving(false);
        setActiveCallId(null);
        void refresh();
      }
    },
    [findingPassport, refresh, resolving, scannerMode, showToast],
  );

  return (
    <div className="master-page">
      {/* Единая синяя шапка-профиль, как у остальных кабинетов
          (RoleHeaderCard). «Выйти» — в три-точечном меню поверх угла
          карты (`shiftActive=false` → только «Выйти»), «Мой QR-код» — в
          боковом столбике. Счётчик открытых вызовов не дублируем: он уже
          в табе «Вызовы · N». */}
      <SeamstressActionsMenu shiftActive={false} />
      <RoleHeaderCard
        name={fullName}
        role="Мастер цеха"
        statusText="Очередь активных вызовов — отсканируйте QR сотрудника, чтобы закрыть"
      />
      {showEmployeeQr ? (
        <div className="employee-toolbar">
          <EmployeeQrButton variant="floating" />
        </div>
      ) : null}

      <div className="master-page__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'calls'}
          className={
            'master-page__tab' + (tab === 'calls' ? ' is-active' : '')
          }
          onClick={() => setTab('calls')}
        >
          Вызовы{items.length > 0 ? ` · ${items.length}` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'board'}
          className={
            'master-page__tab' + (tab === 'board' ? ' is-active' : '')
          }
          onClick={() => setTab('board')}
        >
          Движение тиража
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'employees'}
          className={
            'master-page__tab' + (tab === 'employees' ? ' is-active' : '')
          }
          onClick={() => setTab('employees')}
        >
          Сотрудники
        </button>
        {qtyCorrectionEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'corrections'}
            className={
              'master-page__tab' + (tab === 'corrections' ? ' is-active' : '')
            }
            onClick={() => setTab('corrections')}
          >
            Корректировки
            {corrections.length > 0 ? ` · ${corrections.length}` : ''}
          </button>
        )}
      </div>

      {error && (
        <div className="master-page__error" role="alert">
          {error}
        </div>
      )}

      {toast && (
        <div className="master-page__success" role="status" aria-live="polite">
          {toast}
        </div>
      )}

      {tab === 'board' && <ProductionBoardView />}

      {tab === 'employees' && <EmployeeStatsView />}

      {tab === 'corrections' && qtyCorrectionEnabled && (
        <QtyCorrectionsView
          items={corrections}
          busyId={busyCorrectionId}
          onApprove={onApproveCorrection}
          onReject={onRejectCorrection}
        />
      )}

      {tab === 'calls' && (
        <>
      <button
        type="button"
        className="master-page__scan-passport"
        onClick={onOpenPassportScanner}
        disabled={findingPassport}
        aria-label="Сканировать паспорт изделия для действий мастера"
      >
        <Icon name="scan" size={20} />
        {findingPassport ? 'Ищем паспорт…' : 'Сканировать паспорт'}
      </button>

      <CutReleasePolicyCard
        policy={policy}
        sizes={sizes}
        knownColors={knownColors}
        onChanged={(p) => setPolicy(p)}
        onError={(msg) => setError(msg)}
        onSuccess={(msg) => {
          showToast(msg);
          setError(null);
        }}
      />

      {items.length === 0 ? (
        <div className="master-page__empty">
          <p>Открытых вызовов нет</p>
          <p>Экран обновляется каждые {POLL_INTERVAL_MS / 1000} сек.</p>
        </div>
      ) : (
        items.map((call) => (
          <MasterCallCard
            key={call.id}
            call={call}
            now={now}
            onOpenScanner={onOpenScanner}
            onOpenActions={(p) =>
              setActionsFor({ passport: p, ownerName: call.employee.fullName })
            }
            onResolveManual={onResolveManual}
            busy={resolving && activeCallId === call.id}
            resolvingManual={resolvingManualId === call.id}
          />
        ))
      )}

      <section className="master-archive" aria-label="Архив закрытых вызовов">
        <button
          type="button"
          className="master-archive__toggle"
          onClick={() => setArchiveOpen((v) => !v)}
          aria-expanded={archiveOpen}
        >
          <span>Архив ({resolved.length})</span>
          <span className="master-archive__chevron" aria-hidden>
            {archiveOpen ? '▾' : '▸'}
          </span>
        </button>
        {archiveOpen && (
          resolved.length === 0 ? (
            <div className="master-archive__empty">Закрытых вызовов пока нет</div>
          ) : (
            <ul className="master-archive__list">
              {resolved.map((call) => (
                <ArchivedCallRow key={call.id} call={call} />
              ))}
            </ul>
          )
        )}
      </section>
        </>
      )}

      {scannerMode !== null && (
        <QrScannerModal onScan={onScan} onClose={onCloseScanner} />
      )}

      {actionsFor && (
        <PassportActionsSheet
          passport={actionsFor.passport}
          ownerFullName={actionsFor.ownerName}
          defectTypes={defectTypes}
          onClose={() => setActionsFor(null)}
          onSuccess={(msg) => {
            showToast(msg);
            setError(null);
            void refresh();
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}

interface CardProps {
  call: MasterCallDto;
  now: number;
  onOpenScanner: (callId: string) => void;
  onOpenActions: (passport: MasterCallPassportDto) => void;
  onResolveManual: (callId: string) => void;
  busy: boolean;
  resolvingManual: boolean;
}

function MasterCallCard({
  call,
  now,
  onOpenScanner,
  onOpenActions,
  onResolveManual,
  busy,
  resolvingManual,
}: CardProps) {
  const waited = formatWaited(now - new Date(call.createdAt).getTime());
  const equipmentLabel = call.equipment
    ? `${call.equipment.displayNumber ? `№${call.equipment.displayNumber} ` : ''}${call.equipment.name}`
    : 'Без активной смены';

  return (
    <article className="master-call-card">
      <div className="master-call-card__top">
        <div>
          <h2 className="master-call-card__name">{call.employee.fullName}</h2>
          <div className="master-call-card__meta-row">
            <span>Роль</span>
            <span>{call.employee.role}</span>
          </div>
        </div>
        <div className="master-call-card__waiting" title="Сколько ждёт мастера">
          {waited}
        </div>
      </div>

      <div className="master-call-card__meta">
        <div className="master-call-card__meta-row">
          <span>Оборудование</span>
          <span>{equipmentLabel}</span>
        </div>
        <div className="master-call-card__meta-row">
          <span>Операция</span>
          <span>{call.operation ? call.operation.name : '—'}</span>
        </div>
      </div>

      {call.currentPassports.length > 0 && (
        <section
          className="master-call-card__passports-block"
          aria-label="Действия с кроем"
        >
          <h3 className="master-call-card__passports-title">Действия с кроем</h3>
          <ul className="master-call-card__passports">
            {call.currentPassports.map((p) => (
              <li key={p.id} className="master-call-card__passport">
                <div className="master-call-card__passport-main">
                  <strong>{p.number}</strong>
                  <span>Заказ {p.orderNumber}</span>
                  <span>· {p.size}</span>
                  {p.color && <span>· {p.color}</span>}
                  <span>· qty {p.qtyCut}</span>
                </div>
                <div className="master-call-card__passport-meta">
                  <span>
                    {p.currentOperation
                      ? `Оп: ${p.currentOperation.name}`
                      : 'Без операции'}
                  </span>
                  <span>·</span>
                  <span>{p.status}</span>
                  <span>·</span>
                  <span>
                    {p.currentCell ? `Ячейка ${p.currentCell.code}` : 'На руках'}
                  </span>
                </div>
                <button
                  type="button"
                  className="master-call-card__passport-actions"
                  onClick={() => onOpenActions(p)}
                  aria-label={`Действия с паспортом ${p.number}`}
                >
                  Действия
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="master-call-card__actions">
        <button
          type="button"
          className="master-call-card__resolve"
          onClick={() => onOpenScanner(call.id)}
          disabled={busy || resolvingManual}
        >
          <Icon name="scan" size={18} />
          {busy ? 'Закрываем…' : 'Сканировать QR сотрудника'}
        </button>
        <button
          type="button"
          className="master-call-card__resolve-manual"
          onClick={() => onResolveManual(call.id)}
          disabled={busy || resolvingManual}
          aria-label="Закрыть вызов: проблема решена"
        >
          <Icon name="success" size={18} />
          {resolvingManual ? 'Закрываем…' : 'Проблема решена'}
        </button>
      </div>
    </article>
  );
}

function ArchivedCallRow({ call }: { call: MasterCallDto }) {
  const equipmentLabel = call.equipment
    ? `${call.equipment.displayNumber ? `№${call.equipment.displayNumber} ` : ''}${call.equipment.name}`
    : '—';
  const resolvedAt = call.resolvedAt
    ? new Date(call.resolvedAt).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
  return (
    <li className="master-archive__item">
      <div className="master-archive__item-main">
        <strong>{call.employee.fullName}</strong>
        <span className="master-archive__item-meta">{equipmentLabel}</span>
      </div>
      <span className="master-archive__resolved-badge" aria-label="Проблема решена">
        <Icon name="success" size={14} />
        Проблема решена
      </span>
      <span className="master-archive__item-time" title="Закрыт">
        {resolvedAt}
      </span>
    </li>
  );
}

function formatWaited(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 сек';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} сек`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин`;
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin === 0 ? `${hr} ч` : `${hr} ч ${restMin} мин`;
}
