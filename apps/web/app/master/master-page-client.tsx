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
import { Icon } from '@/components/icon';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import { logoutAction } from '@/app/(auth)/logout-action';
import {
  refreshOpenMasterCallsAction,
  refreshRecentlyResolvedMasterCallsAction,
  resolveMasterCallByEmployeeQrAction,
  resolveMasterCallByIdAction,
} from './actions';
import { PassportActionsSheet } from './passport-actions-sheet';
import { CutReleasePolicyCard } from './cut-release-policy-card';
import { refreshCutReleasePolicyAction } from './cut-release-policy-actions';

const POLL_INTERVAL_MS = 5000;

interface Props {
  initialItems: MasterCallDto[];
  initialError: string | null;
  initialResolved: MasterCallDto[];
  initialPolicy: CutReleasePolicyDto | null;
  sizes: SizeDto[];
}

export function MasterPageClient({
  initialItems,
  initialError,
  initialResolved,
  initialPolicy,
  sizes,
}: Props) {
  const [items, setItems] = useState<MasterCallDto[]>(initialItems);
  const [resolved, setResolved] =
    useState<MasterCallDto[]>(initialResolved);
  const [error, setError] = useState<string | null>(initialError);
  const [policy, setPolicy] = useState<CutReleasePolicyDto | null>(
    initialPolicy,
  );
  const [scannerOpen, setScannerOpen] = useState(false);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolvingManualId, setResolvingManualId] = useState<string | null>(
    null,
  );
  const [archiveOpen, setArchiveOpen] = useState(false);
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
  }, []);

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

  const onOpenScanner = useCallback((callId: string) => {
    setActiveCallId(callId);
    setError(null);
    setScannerOpen(true);
  }, []);

  const onCloseScanner = useCallback(() => {
    setScannerOpen(false);
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
      if (resolving) return;
      const parsed = parseEmployeeQr(decodedText);
      if (!parsed) {
        setScannerOpen(false);
        setActiveCallId(null);
        setError('QR не распознан как сотрудник (ожидается EMPLOYEE:<id>)');
        return;
      }
      setResolving(true);
      setScannerOpen(false);
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
    [refresh, resolving, showToast],
  );

  return (
    <div className="master-page">
      <header className="master-page__header">
        <div>
          <h1 className="master-page__title">Мастер цеха</h1>
          <p className="master-page__subtitle">
            Очередь активных вызовов. Чтобы закрыть — отсканируйте QR
            сотрудника.
          </p>
        </div>
        <div className="master-page__header-actions">
          <span
            className="master-page__count"
            title="Открытых вызовов сейчас"
            aria-label="Открытых вызовов"
          >
            {items.length}
          </span>
          <form action={logoutAction}>
            <button
              type="submit"
              className="master-page__logout"
              aria-label="Выйти из аккаунта"
            >
              <Icon name="logout" size={16} />
              <span>Выйти</span>
            </button>
          </form>
        </div>
      </header>

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

      {scannerOpen && (
        <QrScannerModal onScan={onScan} onClose={onCloseScanner} />
      )}

      {actionsFor && (
        <PassportActionsSheet
          passport={actionsFor.passport}
          ownerFullName={actionsFor.ownerName}
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
