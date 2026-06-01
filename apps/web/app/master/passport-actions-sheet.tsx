'use client';

/**
 * Stage 2 «Мастер цеха» — мобильный bottom-sheet ручных действий
 * мастера над одним паспортом.
 *
 * Контракт API — `apps/api/src/modules/master-actions/*`,
 * server actions — `apps/web/app/master/master-actions-actions.ts`.
 * Контейнер — `apps/web/app/master/master-page-client.tsx` (открывает
 * sheet по нажатию на «Действия» в карточке вызова).
 *
 * Mobile-first ограничения (см. `docs/screens.md §«/master mobile actions UI»`):
 *   - bottom-sheet, не центрированный modal — удобно одной рукой;
 *   - крупные кнопки (`min-height: 56px`), select причины и textarea
 *     комментария — обязательный шаг перед confirm;
 *   - QR-сканер сотрудника / ячейки — общий `<QrScannerModal>`
 *     (тот же, что в `/work` и в основной кнопке «Сканировать QR
 *     сотрудника» на `/master`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MASTER_ACTION_REASON_LABELS,
  MASTER_ACTION_REASONS,
  parseEmployeeQr,
  type MasterActionReason,
  type MasterCallPassportDto,
} from '@sewing/shared';
import type {
  DefectTypeDto,
  EligibleReworkTargetDto,
  QcPassportDetailDto,
} from '@sewing/shared/qc';
import { ModalPortal } from '@/components/modal-portal';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  fetchMasterQcDetailAction,
  masterReturnToCellAction,
  masterSetRouteStepAction,
  masterTransferToEmployeeAction,
  masterUnassignPassportAction,
  recordMasterDefectAction,
  returnMasterToReworkAction,
  type MasterActionResult,
} from './master-actions-actions';
import { PassportHistoryView } from './passport-history-view';

type ActionId = 'unassign' | 'transfer' | 'returnToCell' | 'setRouteStep';

/** ОТК-действия мастера — отдельная ветка рендера (`QcActionBody`),
 *  без поля «причина», с подгрузкой ОТК-карточки паспорта. */
type QcActionId = 'recordDefect' | 'returnToRework';

/**
 * `history` — отдельный «псевдо-action» в sheet'е: вместо формы
 * действия рендерим `PassportHistoryView` с тем же `onBack`-паттерном,
 * что и обычные действия. Это позволяет переиспользовать существующий
 * layout (header сверху, scrollable body, кнопка «Назад»), не
 * раздваивая дерево компонентов.
 */
type Mode = ActionId | QcActionId | 'history';

interface Props {
  passport: MasterCallPassportDto;
  /** ФИО владельца паспорта на момент открытия sheet'а — для подсказки в заголовке. */
  ownerFullName: string;
  /** Справочник видов брака для формы «зафиксировать брак». */
  defectTypes: DefectTypeDto[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const ACTION_LABELS: Record<ActionId, string> = {
  unassign: 'Снять с сотрудника',
  transfer: 'Передать сотруднику',
  returnToCell: 'Вернуть в ячейку',
  setRouteStep: 'Назначить операцию',
};

const QC_ACTION_LABELS: Record<QcActionId, string> = {
  recordDefect: 'Зафиксировать брак',
  returnToRework: 'Вернуть на доработку',
};

const QC_ACTION_HINTS: Record<QcActionId, string> = {
  recordDefect:
    'Отметить брак по паспорту: вид брака, количество и комментарий. «Годных» уменьшится, сдельная выработка пересчитается. Паспорт должен быть в работе.',
  returnToRework:
    'Вернуть паспорт на пошив — выберите операцию (например КИПЕРКА или ОВЕРЛОК) и швею, которая её делала. Её невыплаченное начисление за эту операцию будет отозвано (оплатится при повторном завершении).',
};

const ACTION_HINTS: Record<ActionId, string> = {
  unassign:
    'Паспорт перестанет быть закреплён за сотрудником. Используйте, если он висит на человеке по ошибке.',
  transfer:
    'Передать паспорт другому сотруднику. Если у него открыта смена на операции маршрута — шаг автоматически обновится.',
  returnToCell:
    'Вернуть паспорт в ячейку. CellContent увеличится на qtyCut. Используйте, если паспорт ошибочно выдан.',
  setRouteStep:
    'Перевести паспорт на конкретный шаг маршрута заказа. На откат назад потребуется указать, куда положить паспорт: сотруднику «из рук в руки» или в ячейку. Если возвращаете на уже завершённую операцию (например, ОТК после брака на ВТО) — гейт переоткрывается автоматически.',
};

export function PassportActionsSheet({
  passport,
  ownerFullName,
  defectTypes,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const [mode, setMode] = useState<Mode | null>(null);

  return (
    <ModalPortal>
    <div
      className="master-actions-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Действия с паспортом ${passport.number}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="master-actions-sheet__card">
        <header className="master-actions-sheet__header">
          <div>
            <h3 className="master-actions-sheet__title">
              Паспорт {passport.number}
            </h3>
            <p className="master-actions-sheet__subtitle">
              Заказ {passport.orderNumber} · {passport.size}
              {passport.color ? ` · ${passport.color}` : ''} · qty{' '}
              {passport.qtyCut}
            </p>
            <p className="master-actions-sheet__meta">
              На сотруднике: <strong>{ownerFullName}</strong>
              {passport.currentOperation
                ? ` · операция ${passport.currentOperation.name}`
                : ''}
              {passport.currentCell
                ? ` · ячейка ${passport.currentCell.code}`
                : ''}
            </p>
          </div>
          <button
            type="button"
            className="master-actions-sheet__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </header>

        {mode === null && (
          <div className="master-actions-sheet__menu">
            {/* «Посмотреть историю» — read-only обзор PassportEvent;
                логически идёт ПЕРЕД destructive-действиями, чтобы
                мастер мог сначала разобраться, потом действовать. */}
            <button
              type="button"
              className="master-actions-sheet__menu-item master-actions-sheet__menu-item--history"
              onClick={() => setMode('history')}
            >
              <span className="master-actions-sheet__menu-label">
                Посмотреть историю паспорта
              </span>
              <span className="master-actions-sheet__menu-hint">
                Хронология событий: что было сделано по паспорту, кем и
                когда. Перед действиями стоит сверить состояние.
              </span>
            </button>
            {/* ОТК-действия мастера — логически перед маршрутными:
                это «контроль качества на месте» (брак / возврат на
                пошив), а не правка владельца/шага. */}
            {(['recordDefect', 'returnToRework'] as QcActionId[]).map((id) => (
              <button
                key={id}
                type="button"
                className="master-actions-sheet__menu-item master-actions-sheet__menu-item--qc"
                onClick={() => setMode(id)}
              >
                <span className="master-actions-sheet__menu-label">
                  {QC_ACTION_LABELS[id]}
                </span>
                <span className="master-actions-sheet__menu-hint">
                  {QC_ACTION_HINTS[id]}
                </span>
              </button>
            ))}
            {(['unassign', 'transfer', 'returnToCell', 'setRouteStep'] as ActionId[]).map(
              (id) => (
                <button
                  key={id}
                  type="button"
                  className="master-actions-sheet__menu-item"
                  onClick={() => setMode(id)}
                >
                  <span className="master-actions-sheet__menu-label">
                    {ACTION_LABELS[id]}
                  </span>
                  <span className="master-actions-sheet__menu-hint">
                    {ACTION_HINTS[id]}
                  </span>
                </button>
              ),
            )}
          </div>
        )}

        {mode === 'history' && (
          <PassportHistoryView
            passportId={passport.id}
            passportNumber={passport.number}
            onBack={() => setMode(null)}
          />
        )}

        {(mode === 'recordDefect' || mode === 'returnToRework') && (
          <QcActionBody
            action={mode}
            passport={passport}
            defectTypes={defectTypes}
            onBack={() => setMode(null)}
            onClose={onClose}
            onSuccess={onSuccess}
            onError={onError}
          />
        )}

        {mode !== null &&
          mode !== 'history' &&
          mode !== 'recordDefect' &&
          mode !== 'returnToRework' && (
            <ActionBody
              action={mode}
              passport={passport}
              onBack={() => setMode(null)}
              onClose={onClose}
              onSuccess={onSuccess}
              onError={onError}
            />
          )}
      </div>
    </div>
    </ModalPortal>
  );
}

interface ActionBodyProps {
  action: ActionId;
  passport: MasterCallPassportDto;
  onBack: () => void;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

function ActionBody({
  action,
  passport,
  onBack,
  onClose,
  onSuccess,
  onError,
}: ActionBodyProps) {
  const [reason, setReason] = useState<MasterActionReason | ''>('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  // Action-specific state
  const [employeeQr, setEmployeeQr] = useState<string>('');
  const [cellQr, setCellQr] = useState<string>('');
  const [routeStepIndex, setRouteStepIndex] = useState<number | ''>(
    passport.currentRouteStepIndex ?? '',
  );
  // Placement выбирается только при backward-движении в setRouteStep:
  // паспорт обязан куда-то приземлиться (ячейка ИЛИ сотрудник).
  // По умолчанию 'employee' — «из рук в руки» это типичный сценарий
  // (ВТО заметил брак → тут же отдал ОТК), без беготни до ячейки.
  const [backwardPlacement, setBackwardPlacement] = useState<
    'employee' | 'cell'
  >('employee');
  const [scanner, setScanner] = useState<null | 'employee' | 'cell'>(null);

  // currentRouteStepIndex может быть null (новый паспорт). Тогда отката
  // нет — всё forward. Backward = выбран шаг строго раньше текущего.
  const currentIdx = passport.currentRouteStepIndex ?? 0;
  const isBackward =
    action === 'setRouteStep' &&
    typeof routeStepIndex === 'number' &&
    routeStepIndex < currentIdx;

  const canConfirm = useMemo(() => {
    if (!reason) return false;
    if (action === 'transfer') return employeeQr.trim().length > 0;
    if (action === 'returnToCell') return cellQr.trim().length > 0;
    if (action === 'setRouteStep') {
      if (routeStepIndex === '') return false;
      if (!isBackward) return true;
      return backwardPlacement === 'employee'
        ? employeeQr.trim().length > 0
        : cellQr.trim().length > 0;
    }
    return true;
  }, [
    action,
    reason,
    employeeQr,
    cellQr,
    routeStepIndex,
    isBackward,
    backwardPlacement,
  ]);

  const handleScan = useCallback(
    (decoded: string) => {
      if (scanner === 'employee') {
        // Принимаем сырой QR — server action парсит сам.
        // Подсказку даём только если префикс не совпал (мастер
        // должен видеть, что отсканировал не того).
        const parsed = parseEmployeeQr(decoded);
        if (!parsed) {
          onError('QR не распознан как сотрудник (ожидается EMPLOYEE:<id>)');
          setScanner(null);
          return;
        }
        setEmployeeQr(decoded);
      } else if (scanner === 'cell') {
        setCellQr(decoded);
      }
      setScanner(null);
    },
    [scanner, onError],
  );

  const submit = useCallback(async () => {
    if (!canConfirm || busy) return;
    setBusy(true);
    let res: MasterActionResult;
    try {
      if (action === 'unassign') {
        res = await masterUnassignPassportAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
        });
      } else if (action === 'transfer') {
        res = await masterTransferToEmployeeAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
          employeeQr: employeeQr.trim(),
        });
      } else if (action === 'returnToCell') {
        res = await masterReturnToCellAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
          cellQr: cellQr.trim(),
        });
      } else {
        // Backward требует placement (ячейка ИЛИ сотрудник); forward
        // placement не передаёт — backend по дизайну на forward
        // никого не «привязывает», паспорт уходит «в воздух».
        const placement =
          isBackward && backwardPlacement === 'employee'
            ? { employeeQr: employeeQr.trim() }
            : isBackward && backwardPlacement === 'cell'
              ? { cellQr: cellQr.trim() }
              : {};
        res = await masterSetRouteStepAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
          routeStepIndex:
            typeof routeStepIndex === 'number' ? routeStepIndex : undefined,
          ...placement,
        });
      }
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      onSuccess('Действие выполнено');
      onClose();
    } else {
      onError(res.error);
    }
  }, [
    action,
    backwardPlacement,
    busy,
    canConfirm,
    cellQr,
    comment,
    employeeQr,
    isBackward,
    onClose,
    onError,
    onSuccess,
    passport.id,
    reason,
    routeStepIndex,
  ]);

  return (
    <div className="master-actions-sheet__body">
      <button
        type="button"
        className="master-actions-sheet__back"
        onClick={onBack}
      >
        ← Назад к списку действий
      </button>
      <h4 className="master-actions-sheet__action-title">
        {ACTION_LABELS[action]}
      </h4>
      <p className="master-actions-sheet__action-hint">{ACTION_HINTS[action]}</p>

      {action === 'transfer' && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">Сотрудник</label>
          <div className="master-actions-sheet__row">
            <input
              type="text"
              className="master-actions-sheet__input"
              placeholder="EMPLOYEE:<id>"
              value={employeeQr}
              onChange={(e) => setEmployeeQr(e.target.value)}
            />
            <button
              type="button"
              className="master-actions-sheet__scan"
              onClick={() => setScanner('employee')}
            >
              Сканировать QR
            </button>
          </div>
        </div>
      )}

      {action === 'returnToCell' && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">Ячейка</label>
          <div className="master-actions-sheet__row">
            <input
              type="text"
              className="master-actions-sheet__input"
              placeholder="cell:<id> или код ячейки"
              value={cellQr}
              onChange={(e) => setCellQr(e.target.value)}
            />
            <button
              type="button"
              className="master-actions-sheet__scan"
              onClick={() => setScanner('cell')}
            >
              Сканировать QR
            </button>
          </div>
        </div>
      )}

      {action === 'setRouteStep' && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">Шаг маршрута</label>
          {passport.routeSteps.length === 0 ? (
            <p className="master-actions-sheet__error" role="alert">
              У заказа нет snapshot маршрута — назначать нечего.
            </p>
          ) : (
            <ul className="master-actions-sheet__steps">
              {passport.routeSteps.map((s) => {
                const checked = routeStepIndex === s.index;
                return (
                  <li key={s.index}>
                    <label
                      className={`master-actions-sheet__step${checked ? ' master-actions-sheet__step--active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="routeStep"
                        value={s.index}
                        checked={checked}
                        onChange={() => setRouteStepIndex(s.index)}
                      />
                      <span>
                        Шаг {s.index + 1}: {s.operationName}
                        {s.isCurrent ? ' (текущий)' : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Backward-движение по маршруту: паспорт обязан куда-то
          приземлиться. Даём выбор «из рук в руки» (сотруднику) или
          «в ячейку» — backend принимает один из двух. Скрыто на
          forward, чтобы не путать. */}
      {action === 'setRouteStep' && isBackward && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">
            Куда положить (возврат назад){' '}
            <span className="master-actions-sheet__required">*</span>
          </label>
          <div className="master-actions-sheet__placement">
            <label className="master-actions-sheet__placement-option">
              <input
                type="radio"
                name="backwardPlacement"
                value="employee"
                checked={backwardPlacement === 'employee'}
                onChange={() => setBackwardPlacement('employee')}
              />
              <span>Передать сотруднику (из рук в руки)</span>
            </label>
            <label className="master-actions-sheet__placement-option">
              <input
                type="radio"
                name="backwardPlacement"
                value="cell"
                checked={backwardPlacement === 'cell'}
                onChange={() => setBackwardPlacement('cell')}
              />
              <span>Положить в ячейку</span>
            </label>
          </div>
          {backwardPlacement === 'employee' ? (
            <div className="master-actions-sheet__row">
              <input
                type="text"
                className="master-actions-sheet__input"
                placeholder="EMPLOYEE:<id>"
                value={employeeQr}
                onChange={(e) => setEmployeeQr(e.target.value)}
              />
              <button
                type="button"
                className="master-actions-sheet__scan"
                onClick={() => setScanner('employee')}
              >
                Сканировать QR
              </button>
            </div>
          ) : (
            <div className="master-actions-sheet__row">
              <input
                type="text"
                className="master-actions-sheet__input"
                placeholder="cell:<id> или код ячейки"
                value={cellQr}
                onChange={(e) => setCellQr(e.target.value)}
              />
              <button
                type="button"
                className="master-actions-sheet__scan"
                onClick={() => setScanner('cell')}
              >
                Сканировать QR
              </button>
            </div>
          )}
        </div>
      )}

      <div className="master-actions-sheet__field">
        <label className="master-actions-sheet__label" htmlFor="reason">
          Причина <span className="master-actions-sheet__required">*</span>
        </label>
        <select
          id="reason"
          className="master-actions-sheet__input"
          value={reason}
          onChange={(e) =>
            setReason((e.target.value || '') as MasterActionReason | '')
          }
        >
          <option value="">— выберите причину —</option>
          {MASTER_ACTION_REASONS.map((r) => (
            <option key={r} value={r}>
              {MASTER_ACTION_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      <div className="master-actions-sheet__field">
        <label className="master-actions-sheet__label" htmlFor="comment">
          Комментарий (необязательно)
        </label>
        <textarea
          id="comment"
          className="master-actions-sheet__textarea"
          rows={3}
          maxLength={500}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Например: пересменка, паспорт ушёл другой швее"
        />
      </div>

      <button
        type="button"
        className="master-actions-sheet__confirm"
        onClick={submit}
        disabled={!canConfirm || busy}
      >
        {busy ? 'Выполняем…' : 'Подтвердить'}
      </button>

      {scanner && (
        <QrScannerModal
          onScan={handleScan}
          onClose={() => setScanner(null)}
        />
      )}
    </div>
  );
}

interface QcActionBodyProps {
  action: QcActionId;
  passport: MasterCallPassportDto;
  defectTypes: DefectTypeDto[];
  onBack: () => void;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

/**
 * ОТК-действия мастера — «зафиксировать брак» / «вернуть на доработку».
 *
 * Отдельная от `ActionBody` ветка: здесь нет поля «причина» (как и на
 * `/qc`), но есть подгрузка ОТК-карточки паспорта
 * (`fetchMasterQcDetailAction`) ради `remainingForDefect`,
 * `eligibleReworkTargets` и флагов `canRecordDefect`/`canReturnToRework`.
 * Бизнес-логика — `QcService.recordDefect` / `returnToRework` (тот же
 * код, что у роли QC); UI зеркалит форму брака и `ReworkPicker` из
 * `apps/web/app/qc/qc-work-card.tsx`.
 */
function QcActionBody({
  action,
  passport,
  defectTypes,
  onBack,
  onClose,
  onSuccess,
  onError,
}: QcActionBodyProps) {
  const [detail, setDetail] = useState<QcPassportDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Defect form
  const [defectTypeId, setDefectTypeId] = useState('');
  const [qty, setQty] = useState<number | ''>(1);
  const [comment, setComment] = useState('');

  // Rework picker
  const [reworkPicked, setReworkPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await fetchMasterQcDetailAction(passport.id);
    if (res.ok) {
      setDetail(res.detail);
      setReworkPicked(
        res.detail.eligibleReworkTargets[0]?.operationId ?? null,
      );
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [passport.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const remaining = detail?.remainingForDefect ?? 0;
  const qtyNum = typeof qty === 'number' ? qty : Number(qty);
  const canSubmitDefect =
    !!detail &&
    detail.canRecordDefect &&
    defectTypeId.length > 0 &&
    Number.isFinite(qtyNum) &&
    qtyNum >= 1 &&
    qtyNum <= remaining;

  const submitDefect = useCallback(async () => {
    if (!canSubmitDefect || busy) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof recordMasterDefectAction>>;
    try {
      res = await recordMasterDefectAction(passport.id, {
        defectTypeId,
        qty: qtyNum,
        comment: comment.trim() ? comment.trim() : undefined,
      });
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      onSuccess(`Брак зафиксирован: ${qtyNum} шт.`);
      onClose();
    } else {
      onError(res.error);
    }
  }, [
    busy,
    canSubmitDefect,
    comment,
    defectTypeId,
    onClose,
    onError,
    onSuccess,
    passport.id,
    qtyNum,
  ]);

  const submitRework = useCallback(async () => {
    if (busy || !reworkPicked || !detail) return;
    const target = detail.eligibleReworkTargets.find(
      (t) => t.operationId === reworkPicked,
    );
    if (!target) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        `Вернуть ${passport.number} на ${target.operationName} ` +
          `(${target.finisherEmployeeName})?\n\n` +
          `Невыплаченное начисление за эту операцию будет отозвано.`,
      )
    ) {
      return;
    }
    setBusy(true);
    let res: Awaited<ReturnType<typeof returnMasterToReworkAction>>;
    try {
      res = await returnMasterToReworkAction(passport.id, target.operationId);
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      onSuccess(
        `Возвращено на ${target.operationName} · ${target.finisherEmployeeName}`,
      );
      onClose();
    } else {
      onError(res.error);
    }
  }, [busy, detail, onClose, onError, onSuccess, passport.number, passport.id, reworkPicked]);

  return (
    <div className="master-actions-sheet__body">
      <button
        type="button"
        className="master-actions-sheet__back"
        onClick={onBack}
      >
        ← Назад к списку действий
      </button>
      <h4 className="master-actions-sheet__action-title">
        {QC_ACTION_LABELS[action]}
      </h4>
      <p className="master-actions-sheet__action-hint">
        {QC_ACTION_HINTS[action]}
      </p>

      {loading && (
        <p className="master-actions-sheet__action-hint">Загружаем карточку ОТК…</p>
      )}

      {!loading && loadError && (
        <div className="master-actions-sheet__field">
          <p className="master-actions-sheet__error" role="alert">
            {loadError}
          </p>
          <button
            type="button"
            className="master-actions-sheet__scan"
            onClick={() => void load()}
          >
            Повторить
          </button>
        </div>
      )}

      {!loading && detail && (
        <>
          {/* Сводка по количеству — чтобы мастер видел, сколько годных
              осталось и сколько уже в браке. */}
          <p className="master-actions-sheet__meta">
            Раскроено <strong>{detail.qtyCut}</strong> · брак{' '}
            <strong>{detail.qtyDefect}</strong> · годных{' '}
            <strong>{detail.qtyGood}</strong>
          </p>

          {action === 'recordDefect' &&
            (detail.canRecordDefect ? (
              <>
                <div className="master-actions-sheet__field">
                  <label className="master-actions-sheet__label" htmlFor="qc-defect-type">
                    Вид брака{' '}
                    <span className="master-actions-sheet__required">*</span>
                  </label>
                  <select
                    id="qc-defect-type"
                    className="master-actions-sheet__input"
                    value={defectTypeId}
                    onChange={(e) => setDefectTypeId(e.target.value)}
                    disabled={busy || defectTypes.length === 0}
                  >
                    <option value="">— выбрать —</option>
                    {defectTypes.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.code}
                      </option>
                    ))}
                  </select>
                  {defectTypes.length === 0 && (
                    <p className="master-actions-sheet__error" role="alert">
                      Справочник видов брака пуст или недоступен.
                    </p>
                  )}
                </div>

                <div className="master-actions-sheet__field">
                  <label className="master-actions-sheet__label" htmlFor="qc-defect-qty">
                    Количество брака, шт.{' '}
                    <span className="master-actions-sheet__required">*</span>
                  </label>
                  <input
                    id="qc-defect-qty"
                    type="number"
                    className="master-actions-sheet__input"
                    min={1}
                    max={Math.max(remaining, 1)}
                    step={1}
                    value={qty}
                    onChange={(e) =>
                      setQty(e.target.value === '' ? '' : Number(e.target.value))
                    }
                    disabled={busy || remaining === 0}
                  />
                  <p className="master-actions-sheet__action-hint">
                    Доступно к фиксации: <strong>{remaining}</strong> шт.
                  </p>
                </div>

                <div className="master-actions-sheet__field">
                  <label className="master-actions-sheet__label" htmlFor="qc-defect-comment">
                    Комментарий (необязательно)
                  </label>
                  <textarea
                    id="qc-defect-comment"
                    className="master-actions-sheet__textarea"
                    rows={3}
                    maxLength={500}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Например: пятно на полочке"
                    disabled={busy}
                  />
                </div>

                <button
                  type="button"
                  className="master-actions-sheet__confirm"
                  onClick={submitDefect}
                  disabled={!canSubmitDefect || busy}
                >
                  {busy ? 'Записываем…' : 'Зафиксировать брак'}
                </button>
              </>
            ) : (
              <p className="master-actions-sheet__error" role="alert">
                {detail.status !== 'IN_PROGRESS'
                  ? 'Паспорт ещё не в работе или уже завершён — фиксировать брак нельзя.'
                  : 'Все штуки этого паспорта уже отмечены как брак.'}
              </p>
            ))}

          {action === 'returnToRework' &&
            (detail.eligibleReworkTargets.length > 0 ? (
              <>
                <div className="master-actions-sheet__field">
                  <label className="master-actions-sheet__label">
                    Куда вернуть{' '}
                    <span className="master-actions-sheet__required">*</span>
                  </label>
                  <ul className="master-actions-sheet__steps">
                    {detail.eligibleReworkTargets.map((t: EligibleReworkTargetDto) => {
                      const checked = reworkPicked === t.operationId;
                      return (
                        <li key={t.operationId}>
                          <label
                            className={`master-actions-sheet__step${checked ? ' master-actions-sheet__step--active' : ''}`}
                          >
                            <input
                              type="radio"
                              name="qc-rework-target"
                              value={t.operationId}
                              checked={checked}
                              onChange={() => setReworkPicked(t.operationId)}
                              disabled={busy}
                            />
                            <span>
                              <strong>{t.operationName}</strong> ·{' '}
                              {t.finisherEmployeeName}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <button
                  type="button"
                  className="master-actions-sheet__confirm"
                  onClick={submitRework}
                  disabled={busy || !reworkPicked}
                >
                  {busy ? 'Возвращаем…' : 'Вернуть на доработку'}
                </button>
              </>
            ) : (
              <p className="master-actions-sheet__error" role="alert">
                Возвращать некуда: по паспорту нет завершённых операций
                пошива, доступных для возврата.
              </p>
            ))}
        </>
      )}
    </div>
  );
}

