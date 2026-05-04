'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import Link from 'next/link';
import type { ShiftSessionDto } from '@sewing/shared/shifts';
import {
  issuePassportAction,
  scanPassportAction,
  stopShiftAction,
} from './actions';
import { QrScannerModal } from './qr-scanner-modal';
import { ShelfPlacementPanel } from './shelf-placement-panel';
import { initialWorkFormState, type WorkFormState } from './state';

interface Props {
  shift: ShiftSessionDto;
}

type Mode = 'issue' | 'scan';

const PASSPORT_STATUS_LABELS: Record<string, string> = {
  CREATED: 'Создан',
  IN_PROGRESS: 'В пошиве',
  PACKED: 'Упакован',
  CANCELLED: 'Отменён',
};

function StopButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger" disabled={pending}>
      {pending ? 'Завершаем…' : 'Завершить смену'}
    </button>
  );
}

function SubmitScanButton({ mode }: { mode: Mode }) {
  const { pending } = useFormStatus();
  const label =
    mode === 'issue'
      ? pending
        ? 'Выдаём крой…'
        : 'Получить крой'
      : pending
        ? 'Сканируем…'
        : 'Принять на операцию';
  return (
    <button
      type="submit"
      className="btn btn-primary btn-lg btn-block"
      disabled={pending}
    >
      {label}
    </button>
  );
}

function ResultCard({ state, mode }: { state: WorkFormState; mode: Mode }) {
  if (state.error) {
    return (
      <div className="error-box" role="alert">
        <div className="error-box__msg">{state.error}</div>
        {state.errorRequestId && (
          <div className="error-box__rid" title="Идентификатор запроса для поддержки">
            req: <code>{state.errorRequestId}</code>
          </div>
        )}
      </div>
    );
  }
  if (!state.passport || !state.info) return null;
  const p = state.passport;
  return (
    <div className={`result-card result-card--${mode}`} role="status">
      <div className="result-card__header">
        <span>{state.info}</span>
        <span
          className={`status-badge ${p.status.toLowerCase()}`}
          title={PASSPORT_STATUS_LABELS[p.status] ?? p.status}
        >
          {PASSPORT_STATUS_LABELS[p.status] ?? p.status}
        </span>
      </div>
      <div className="result-card__row">
        <span>Паспорт</span>
        <strong>
          <Link href={`/passports/${p.id}`}>{p.number}</Link>
        </strong>
      </div>
      <div className="result-card__row">
        <span>Изделие</span>
        <strong>{p.productName} · {p.color}</strong>
      </div>
      <div className="result-card__row">
        <span>Размер</span>
        <strong>{p.sizeCode}</strong>
      </div>
      <div className="result-card__row">
        <span>Количество</span>
        <strong>
          {p.qtyCut} шт{' '}
          <span className="result-card__row-meta">
            · годных {p.qtyGood}
          </span>
        </strong>
      </div>
    </div>
  );
}

function ScanForm({ mode, hint, title }: { mode: Mode; hint: string; title: string }) {
  const [code, setCode] = useState('');
  const action = mode === 'issue' ? issuePassportAction : scanPassportAction;
  const [state, formAction] = useFormState(action, initialWorkFormState);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  // Помечаем код, пришедший из QR — сабмитим в эффекте после рендера,
  // когда контролируемое поле уже получит новое value.
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);

  // После любого ответа сервера возвращаем фокус в поле ввода кода:
  // швея/ВТО может сканировать QR один за другим, не трогая курсор
  // (см. docs/pilot/faq.md, ADR-0008).
  useEffect(() => {
    inputRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (pendingAutoSubmit && code) {
      formRef.current?.requestSubmit();
      setPendingAutoSubmit(false);
    }
  }, [pendingAutoSubmit, code]);

  const handleScanSuccess = (decodedText: string) => {
    setScannerOpen(false);
    setCode(decodedText.trim());
    setPendingAutoSubmit(true);
  };

  return (
    <>
      <form
        ref={formRef}
        action={(fd) => {
          formAction(fd);
          setCode('');
        }}
        className="scan-card"
      >
        <div>
          <h2 className="scan-card__title">{title}</h2>
          <p className="scan-card__hint">{hint}</p>
        </div>
        <label className="scan-card__input" htmlFor={`code-${mode}`}>
          <span className="scan-card__input-label">Код паспорта</span>
          <input
            ref={inputRef}
            id={`code-${mode}`}
            name="code"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Отсканируйте QR или введите код"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </label>
        <button
          type="button"
          className="btn btn-block scan-card__camera"
          onClick={() => setScannerOpen(true)}
        >
          Сканировать камерой
        </button>
        <SubmitScanButton mode={mode} />
        <ResultCard state={state} mode={mode} />
      </form>
      {scannerOpen && (
        <QrScannerModal
          onScan={handleScanSuccess}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </>
  );
}

export function ActiveShiftPanel({ shift }: Props) {
  // Швея ходит на /work через `SeamstressActivePanel` напрямую из
  // `page.tsx` (см. ТЗ §3, mobile-first single-button flow), помощник
  // раскройщика — через `CutterAssistantWorkPanel`. QC, IRONING,
  // PACKING на `/work` вообще не приходят: для них в `app/work/page.tsx`
  // стоит server-side редирект в их primary workspace
  // (см. модель «одно рабочее окно на роль» в `apps/web/lib/rbac.ts`).
  // Сюда фактически попадает только CUTTER и менеджеры/админ — они
  // видят дефолтный layout с двумя табами «Получить крой / Сканировать
  // паспорт».
  return <DefaultActivePanel shift={shift} />;
}

/**
 * Упрощённый /work для помощника раскройщика. Два action-card одного
 * визуального уровня:
 *
 *   1. **«Выпустить паспорт»** — переход к упрощённому выбору заказа
 *      на раскрое (`/work/cut-orders`). Этот server-route сам решает,
 *      что показать дальше:
 *        - один заказ в `IN_PRODUCTION` → сразу `redirect` на
 *          `/orders/:id/passports/new` (помощник не выбирает руками);
 *        - несколько заказов → короткий список карточек по названию
 *          позиции;
 *        - ни одного → empty state «Нет заказов на раскрое».
 *
 *   2. **«Разместить на стеллаж»** — scan-driven session-flow без
 *      перехода на отдельный route. Открывает камеру → confirm-модалка
 *      ячейки → session-режим скана паспортов в подтверждённую ячейку.
 *      Всё это инкапсулировано в `ShelfPlacementPanel`. Backend = источник
 *      истины (`/api/cells/by-code` + `/api/passports/by-code` +
 *      `/api/passports/:id/place`), новых бизнес-правил здесь нет
 *      (см. `docs/flows.md §F3b`).
 *
 * Панель рендерится только при активной смене — `app/work/page.tsx`
 * до этого показывает помощнику `SeamstressShiftStart` (тот же
 * QR-flow «оборудование → разрешённая операция → подтверждение»).
 * Это даёт корректный `equipmentId` в shift-session, без которого
 * print-job для «Выпустить паспорт» падает в
 * `SHIFT_SESSION_REQUIRED` (см.
 * `apps/api/src/modules/printers/print-jobs.service.ts:resolvePrinter`).
 *
 * Завершение смены и logout лежат в общем `SeamstressActionsMenu`
 * (три-точечное меню в углу `/work`), который теперь используется и
 * для CUTTER_ASSISTANT — так мы не дублируем «Завершить смену» прямо
 * на белом экране.
 */
export function CutterAssistantWorkPanel() {
  const [shelfActive, setShelfActive] = useState(false);

  if (shelfActive) {
    return <ShelfPlacementPanel onClose={() => setShelfActive(false)} />;
  }

  return (
    <div className="seamstress-work cutter-assistant-work">
      <div className="scan-card scan-card--simple">
        <div>
          <h2 className="scan-card__title">Выпустить паспорт</h2>
          <p className="scan-card__hint">
            Откройте заказ на раскрое — паспорт будет создан в один тап.
          </p>
        </div>
        <Link
          className="btn btn-primary btn-lg btn-block"
          href="/work/cut-orders"
          prefetch={false}
        >
          Выпустить паспорт
        </Link>
      </div>

      <div className="scan-card scan-card--simple">
        <div>
          <h2 className="scan-card__title">Разместить крой на стеллаж</h2>
          <p className="scan-card__hint">
            Сканируйте ячейку, подтвердите её — затем сканируйте паспорта
            один за другим.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block scan-card__primary-camera"
          onClick={() => setShelfActive(true)}
        >
          Разместить на стеллаж
        </button>
      </div>
    </div>
  );
}

function DefaultActivePanel({ shift }: { shift: ShiftSessionDto }) {
  const [stopState, stopAction] = useFormState(
    stopShiftAction,
    initialWorkFormState,
  );
  const [mode, setMode] = useState<Mode>('issue');

  return (
    <div className="work-active">
      <div className="work-tabs" role="tablist" aria-label="Режим работы">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'issue'}
          className={`work-tab ${mode === 'issue' ? 'is-active' : ''}`}
          onClick={() => setMode('issue')}
        >
          Получить крой
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'scan'}
          className={`work-tab ${mode === 'scan' ? 'is-active' : ''}`}
          onClick={() => setMode('scan')}
        >
          Сканировать паспорт
        </button>
      </div>

      {mode === 'issue' ? (
        <ScanForm
          key="issue"
          mode="issue"
          title="Получить крой"
          // Подсказка нейтральная: после soft-route MVP паспорт может
          // прийти как из ячейки (legacy / опциональный буфер), так и
          // из маршрутного потока без ячейки. Backend сам выбирает
          // ветку (см. `PassportsService.issueToEmployee` и
          // `docs/flows.md §F3a`); UI просто принимает приём.
          hint="Отсканируйте QR паспорта — если он лежит в ячейке, система спишет его с ячейки; если идёт по маршруту, примет напрямую."
        />
      ) : (
        <ScanForm
          key="scan"
          mode="scan"
          title="Сканирование на операции"
          hint={`Каждое сканирование — это переход. Паспорт встанет на «${shift.operationName}».`}
        />
      )}

      <form
        action={stopAction}
        className="work-active__shift-end"
        aria-label="Завершить смену"
      >
        <StopButton />
      </form>
      {stopState.error && (
        <div className="error-box">{stopState.error}</div>
      )}
    </div>
  );
}
