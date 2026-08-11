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
  SYSTEM_ROLE_LABELS,
  parseAnyEmployeeQr,
  type MasterActionReason,
  type MasterCallPassportDto,
  type MasterSelfOperationStepDto,
  type MasterSelfOperationStepsDto,
  type MasterTransferCandidateDto,
} from '@sewing/shared';
import type {
  DefectTypeDto,
  EligibleReworkTargetDto,
  QcPassportDetailDto,
} from '@sewing/shared/qc';
import { ModalPortal } from '@/components/modal-portal';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  applyMasterQtyCorrectionAction,
  fetchMasterQcDetailAction,
  fetchMasterSelfOperationStepsAction,
  fetchMasterTransferCandidatesAction,
  masterReturnToCellAction,
  masterSelfOperationAction,
  masterSetRouteStepAction,
  masterTransferToEmployeeAction,
  masterUnassignPassportAction,
  recordMasterDefectAction,
  resolveMasterEmployeeQrAction,
  returnMasterToReworkAction,
  type MasterActionResult,
} from './master-actions-actions';
import { PassportHistoryView } from './passport-history-view';
import { DefectTypeCreatableSelect } from '@/components/qc/defect-type-creatable-select';

type ActionId = 'unassign' | 'transfer' | 'returnToCell' | 'setRouteStep';

/**
 * «Выполнить операцию самой» — отдельная ветка рендера
 * (`SelfOperationBody`): мастер фиксирует СВОЮ работу, поэтому здесь
 * нет поля «причина», зато есть подгрузка шагов маршрута с их
 * доступностью (`fetchMasterSelfOperationStepsAction`).
 */
type WorkActionId = 'selfOperation';

/** ОТК-действия мастера — отдельная ветка рендера (`QcActionBody`),
 *  без поля «причина», с подгрузкой ОТК-карточки паспорта. */
type QcActionId = 'recordDefect' | 'returnToRework' | 'qtyCorrection';

/**
 * `history` — отдельный «псевдо-action» в sheet'е: вместо формы
 * действия рендерим `PassportHistoryView` с тем же `onBack`-паттерном,
 * что и обычные действия. Это позволяет переиспользовать существующий
 * layout (header сверху, scrollable body, кнопка «Назад»), не
 * раздваивая дерево компонентов.
 */
type Mode = ActionId | QcActionId | WorkActionId | 'history';

interface Props {
  passport: MasterCallPassportDto;
  /** ФИО владельца паспорта на момент открытия sheet'а — для подсказки в заголовке. */
  ownerFullName: string;
  /** Справочник видов брака для формы «зафиксировать брак». */
  defectTypes: DefectTypeDto[];
  /**
   * Показывать ли пункт «Корректировка количества» (одношаговая
   * корректировка мастером, `applyMasterQtyCorrectionAction`).
   * По умолчанию выключен — контейнер включает его явно.
   */
  qtyCorrectionEnabled?: boolean;
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
  qtyCorrection: 'Корректировка количества',
};

const QC_ACTION_HINTS: Record<QcActionId, string> = {
  recordDefect:
    'Отметить брак по паспорту: вид брака, количество и комментарий. «Годных» уменьшится, сдельная выработка пересчитается. Паспорт должен быть в работе.',
  returnToRework:
    'Вернуть паспорт на пошив — выберите операцию (например КИПЕРКА или ОВЕРЛОК) и швею, которая её делала. Её невыплаченное начисление за эту операцию будет отозвано (оплатится при повторном завершении).',
  qtyCorrection:
    'Увеличить или уменьшить фактическое количество по паспорту. Применяется сразу, без заявки: изменит «раскроено»/«годных» и пересчитает сдельные начисления. Паспорт должен быть в работе.',
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
  qtyCorrectionEnabled = false,
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
            {/* «Выполнить операцию самой» — единственное действие, где
                мастер фиксирует СВОЮ работу, а не правит чужую. Стоит
                первым: это рутина у станка, а не разбор проблемы. */}
            <button
              type="button"
              className="master-actions-sheet__menu-item master-actions-sheet__menu-item--work"
              onClick={() => setMode('selfOperation')}
            >
              <span className="master-actions-sheet__menu-label">
                Выполнить операцию самой
              </span>
              <span className="master-actions-sheet__menu-hint">
                Вы делаете операцию сами: выберите её в маршруте заказа.
                Паспорт перейдёт на этот шаг, как после работы швеи.
              </span>
            </button>
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
                пошив / корректировка количества), а не правка
                владельца/шага. */}
            {(
              [
                'recordDefect',
                'returnToRework',
                ...(qtyCorrectionEnabled ? (['qtyCorrection'] as const) : []),
              ] as QcActionId[]
            ).map((id) => (
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

        {mode === 'selfOperation' && (
          <SelfOperationBody
            passport={passport}
            onBack={() => setMode(null)}
            onClose={onClose}
            onSuccess={onSuccess}
            onError={onError}
          />
        )}

        {(mode === 'recordDefect' ||
          mode === 'returnToRework' ||
          mode === 'qtyCorrection') && (
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
          mode !== 'selfOperation' &&
          mode !== 'recordDefect' &&
          mode !== 'returnToRework' &&
          mode !== 'qtyCorrection' && (
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

  // Action-specific state.
  //
  // Получателя держим как `employeeId`, а не как сырой QR: список
  // кандидатов отдаёт id, а скан бумажной этикетки `EMPLOYEE:<id>`
  // разбирается тут же (`parseEmployeeQr`). Свободного ввода QR-строки
  // здесь больше нет — 11.08.2026 он дал 17 подряд 400
  // `INVALID_EMPLOYEE_QR`: в поле физически нечего было ввести, кроме
  // cuid с бумажки, которой у мастера на руках нет.
  const [employeeId, setEmployeeId] = useState<string>('');
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
    if (action === 'transfer') return employeeId.length > 0;
    if (action === 'returnToCell') return cellQr.trim().length > 0;
    if (action === 'setRouteStep') {
      if (routeStepIndex === '') return false;
      if (!isBackward) return true;
      return backwardPlacement === 'employee'
        ? employeeId.length > 0
        : cellQr.trim().length > 0;
    }
    return true;
  }, [
    action,
    reason,
    employeeId,
    cellQr,
    routeStepIndex,
    isBackward,
    backwardPlacement,
  ]);

  const handleScan = useCallback(
    async (decoded: string) => {
      if (scanner === 'employee') {
        // В цехе два бейджа: бумажная этикетка `EMPLOYEE:<id>` и «Мой
        // QR-код» с телефона (`SEWING_EMPLOYEE:<token>`). Второй
        // подписан — `employeeId` из него достаёт только backend,
        // поэтому за карточкой человека идём на сервер. Чужой QR
        // (паспорт, ячейка) отсекаем здесь же, до запроса.
        setScanner(null);
        if (!parseAnyEmployeeQr(decoded)) {
          onError(
            'Это не QR сотрудника. Отсканируйте бейдж или выберите человека в списке.',
          );
          return;
        }
        const res = await resolveMasterEmployeeQrAction(decoded);
        if (!res.ok) {
          onError(res.error);
          return;
        }
        setEmployeeId(res.result.employeeId);
        if (!res.result.active) {
          onError(
            `${res.result.fullName} деактивирован — выберите другого сотрудника.`,
          );
        }
        return;
      }
      if (scanner === 'cell') {
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
          employeeId,
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
            ? { employeeId }
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
    employeeId,
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
        <EmployeePicker
          passportId={passport.id}
          selectedId={employeeId}
          onSelect={setEmployeeId}
          onScanClick={() => setScanner('employee')}
        />
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
            <EmployeePicker
              passportId={passport.id}
              selectedId={employeeId}
              onSelect={setEmployeeId}
              onScanClick={() => setScanner('employee')}
              hideLabel
            />
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

interface EmployeePickerProps {
  passportId: string;
  selectedId: string;
  onSelect: (employeeId: string) => void;
  onScanClick: () => void;
  /** Внутри блока «куда положить» подпись уже есть — не дублируем. */
  hideLabel?: boolean;
}

/**
 * Выбор получателя паспорта: список активных сотрудников с их открытой
 * сменой (`GET /api/master-actions/transfer-candidates`).
 *
 * Порядок строк приходит с сервера и НЕ пересортировывается здесь:
 * сверху те, чья смена стоит на текущем шаге паспорта — только для них
 * передача сдвинет и шаг маршрута, а не одного лишь владельца.
 *
 * Поиск по ФИО показываем с 8 человек: в цехе их два десятка, и на
 * телефоне листать длинный список неудобно.
 */
function EmployeePicker({
  passportId,
  selectedId,
  onSelect,
  onScanClick,
  hideLabel = false,
}: EmployeePickerProps) {
  const [rows, setRows] = useState<MasterTransferCandidateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await fetchMasterTransferCandidatesAction(passportId);
    if (res.ok) {
      setRows(res.result.rows);
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [passportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((r) => r.fullName.toLowerCase().includes(needle))
    : rows;

  // Отсканированный бейдж мог принадлежать сотруднику вне списка
  // (уволен / деактивирован). Молча «ничего не выбрано» здесь хуже
  // ошибки: мастер жмёт «Подтвердить» и не понимает отказа.
  const selectedRow = rows.find((r) => r.id === selectedId) ?? null;
  const selectedIsUnknown = selectedId !== '' && !selectedRow && !loading;

  return (
    <div className="master-actions-sheet__field">
      {!hideLabel && (
        <label className="master-actions-sheet__label">
          Сотрудник <span className="master-actions-sheet__required">*</span>
        </label>
      )}
      <div className="master-actions-sheet__row">
        {rows.length >= 8 && (
          <input
            type="text"
            className="master-actions-sheet__input"
            placeholder="Поиск по фамилии"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <button
          type="button"
          className="master-actions-sheet__scan"
          onClick={onScanClick}
        >
          Сканировать бейдж
        </button>
      </div>

      {loading && (
        <p className="master-actions-sheet__hint">Загружаем сотрудников…</p>
      )}
      {loadError && (
        <p className="master-actions-sheet__error" role="alert">
          {loadError}
        </p>
      )}
      {selectedIsUnknown && (
        <p className="master-actions-sheet__error" role="alert">
          Отсканированного сотрудника нет среди активных — выберите
          человека в списке.
        </p>
      )}
      {!loading && !loadError && visible.length === 0 && (
        <p className="master-actions-sheet__hint">
          {rows.length === 0
            ? 'Активных сотрудников нет.'
            : 'Никто не найден — измените поиск.'}
        </p>
      )}

      {visible.length > 0 && (
        <ul className="master-actions-sheet__people">
          {visible.map((r) => {
            const active = r.id === selectedId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className={`master-actions-sheet__person${active ? ' master-actions-sheet__person--active' : ''}`}
                  onClick={() => onSelect(r.id)}
                  aria-pressed={active}
                >
                  <span className="master-actions-sheet__person-name">
                    {r.fullName}
                  </span>
                  <span className="master-actions-sheet__person-meta">
                    {SYSTEM_ROLE_LABELS[r.role] ?? r.role}
                    {r.activeShift
                      ? ` · смена: ${r.activeShift.operationName}${
                          r.activeShift.equipmentLabel
                            ? ` (${r.activeShift.equipmentLabel})`
                            : ''
                        }`
                      : ' · смена не открыта'}
                    {r.passportsInProgress > 0
                      ? ` · на руках ${r.passportsInProgress}`
                      : ''}
                  </span>
                  {r.activeShift?.operationIsCurrentStep && (
                    <span className="master-actions-sheet__person-badge">
                      на текущем шаге паспорта
                    </span>
                  )}
                  {r.activeShift &&
                    !r.activeShift.operationIsCurrentStep &&
                    r.activeShift.operationInRoute && (
                      <span className="master-actions-sheet__person-badge master-actions-sheet__person-badge--muted">
                        операция есть в маршруте
                      </span>
                    )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface SelfOperationBodyProps {
  passport: MasterCallPassportDto;
  onBack: () => void;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

/**
 * «Выполнить операцию самой» — мастер делает операцию руками, и паспорт
 * должен поехать дальше по маршруту.
 *
 * Экран показывает ВЕСЬ снимок маршрута заказа, а не только доступные
 * шаги: недоступный шаг с причиной («сначала закройте КИПЕРКУ»)
 * отвечает на вопрос мастера лучше, чем его отсутствие в списке.
 * Доступность считает бэкенд тем же расчётом, что и «получить крой» у
 * швеи (`previewOperationAvailability`) — своих правил у экрана нет.
 *
 * Станок спрашиваем, только если к операции их привязано несколько:
 * у «ПУГОВИЦА» рабочее место одно и подставляется само.
 */
function SelfOperationBody({
  passport,
  onBack,
  onClose,
  onSuccess,
  onError,
}: SelfOperationBodyProps) {
  const [data, setData] = useState<MasterSelfOperationStepsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [equipmentId, setEquipmentId] = useState<string>('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await fetchMasterSelfOperationStepsAction(passport.id);
    if (res.ok) {
      setData(res.result);
      // Предвыбор — первый доступный шаг: чаще всего это и есть та
      // операция, ради которой мастер открыла экран.
      const first = res.result.steps.find((s) => s.available);
      setPicked(first?.operationId ?? null);
      setEquipmentId(
        first && first.equipment.length === 1 ? first.equipment[0]!.id : '',
      );
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [passport.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickedStep =
    data?.steps.find((s) => s.operationId === picked) ?? null;

  const pick = useCallback((step: MasterSelfOperationStepDto) => {
    setPicked(step.operationId);
    // Один станок — подставляем молча, несколько — мастер выбирает
    // сама (по `equipmentId` события считают загрузку оборудования).
    setEquipmentId(step.equipment.length === 1 ? step.equipment[0]!.id : '');
  }, []);

  const noEquipment = !!pickedStep && pickedStep.equipment.length === 0;
  const needsEquipmentChoice = !!pickedStep && pickedStep.equipment.length > 1;
  const canSubmit =
    !!pickedStep &&
    pickedStep.available &&
    !noEquipment &&
    (!needsEquipmentChoice || equipmentId !== '');

  const submit = useCallback(async () => {
    if (!pickedStep || !canSubmit || busy) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof masterSelfOperationAction>>;
    try {
      res = await masterSelfOperationAction(passport.id, {
        operationId: pickedStep.operationId,
        ...(equipmentId ? { equipmentId } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      onSuccess(`Операция «${pickedStep.operationName}» выполнена`);
      onClose();
    } else {
      onError(res.error);
    }
  }, [
    busy,
    canSubmit,
    comment,
    equipmentId,
    onClose,
    onError,
    onSuccess,
    passport.id,
    pickedStep,
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
        Выполнить операцию самой
      </h4>
      <p className="master-actions-sheet__action-hint">
        Операция запишется на вас: паспорт перейдёт на этот шаг маршрута,
        как после работы швеи.
      </p>

      {loading && (
        <p className="master-actions-sheet__action-hint">Загружаем маршрут…</p>
      )}

      {loadError && (
        <p className="master-actions-sheet__error" role="alert">
          {loadError}
        </p>
      )}

      {data && !loading && (
        <>
          <div className="master-actions-sheet__field">
            <label className="master-actions-sheet__label">
              Операция маршрута{' '}
              <span className="master-actions-sheet__required">*</span>
            </label>
            <ul className="master-actions-sheet__steps">
              {data.steps.map((s) => {
                const checked = picked === s.operationId;
                return (
                  <li key={`${s.index}-${s.operationId}`}>
                    <label
                      className={
                        'master-actions-sheet__step' +
                        (checked ? ' master-actions-sheet__step--active' : '') +
                        (s.available
                          ? ''
                          : ' master-actions-sheet__step--blocked')
                      }
                    >
                      <input
                        type="radio"
                        name="self-operation-target"
                        value={s.operationId}
                        checked={checked}
                        onChange={() => pick(s)}
                        disabled={busy || !s.available}
                      />
                      <span>
                        <strong>{s.operationName}</strong>
                        {s.isCurrent ? ' · текущий шаг' : ''}
                        {s.finished ? ' · выполнена' : ''}
                        {!s.available && s.blockedReason ? (
                          <span className="master-actions-sheet__step-note">
                            {s.blockedReason}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          {noEquipment && (
            <p className="master-actions-sheet__error" role="alert">
              К операции «{pickedStep?.operationName}» не привязано ни одного
              активного рабочего места — привяжите станок в справочнике
              оборудования.
            </p>
          )}

          {needsEquipmentChoice && (
            <div className="master-actions-sheet__field">
              <label
                className="master-actions-sheet__label"
                htmlFor="self-operation-equipment"
              >
                Рабочее место{' '}
                <span className="master-actions-sheet__required">*</span>
              </label>
              <select
                id="self-operation-equipment"
                className="master-actions-sheet__input"
                value={equipmentId}
                onChange={(e) => setEquipmentId(e.target.value)}
                disabled={busy}
              >
                <option value="">— выберите станок —</option>
                {pickedStep?.equipment.map((eq) => (
                  <option key={eq.id} value={eq.id}>
                    {eq.name} ({eq.code})
                  </option>
                ))}
              </select>
            </div>
          )}

          {!data.pieceworkPaid && (
            <p className="master-actions-sheet__notice">
              У вас оклад — сдельного начисления за операцию не будет. Работа
              зачтётся в маршрут и в историю паспорта.
            </p>
          )}

          <div className="master-actions-sheet__field">
            <label
              className="master-actions-sheet__label"
              htmlFor="self-operation-comment"
            >
              Комментарий (необязательно)
            </label>
            <textarea
              id="self-operation-comment"
              className="master-actions-sheet__textarea"
              rows={2}
              maxLength={500}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: пришила пуговицы, швея была на другой операции"
              disabled={busy}
            />
          </div>

          <button
            type="button"
            className="master-actions-sheet__confirm"
            onClick={submit}
            disabled={!canSubmit || busy}
          >
            {busy ? 'Выполняем…' : 'Выполнить операцию'}
          </button>
        </>
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
 * ОТК-действия мастера — «зафиксировать брак» / «вернуть на доработку» /
 * «корректировка количества».
 *
 * Отдельная от `ActionBody` ветка: здесь нет поля «причина» (как и на
 * `/qc`), но есть подгрузка ОТК-карточки паспорта
 * (`fetchMasterQcDetailAction`) ради `remainingForDefect`,
 * `eligibleReworkTargets` и флагов `canRecordDefect`/`canReturnToRework`.
 * Бизнес-логика — `QcService.recordDefect` / `returnToRework` (тот же
 * код, что у роли QC); UI зеркалит форму брака и `ReworkPicker` из
 * `apps/web/app/qc/qc-work-card.tsx`.
 *
 * Корректировка количества зеркалит `QtyCorrectionSheet` оттуда же, но
 * в отличие от ОТК применяется одним шагом без заявки
 * (`applyMasterQtyCorrectionAction` → `applyByMaster` на бэке): мастер
 * сам аппрувер. Если по паспорту уже висит `PENDING`-заявка ОТК
 * (`detail.pendingQtyCorrection`) — вместо формы отсылаем во вкладку
 * «Корректировки».
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

  // Qty correction form
  const [qtyAfter, setQtyAfter] = useState<string>('');
  const [qtyReason, setQtyReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await fetchMasterQcDetailAction(passport.id);
    if (res.ok) {
      setDetail(res.detail);
      setReworkPicked(
        res.detail.eligibleReworkTargets[0]?.operationId ?? null,
      );
      // Дефолт формы корректировки — текущие годные (как на /qc).
      setQtyAfter(String(res.detail.qtyGood));
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

  // --- Корректировка количества (зеркало QtyCorrectionSheet с /qc) ---
  const qtyAfterNum = Number(qtyAfter);
  const qtyAfterValid =
    qtyAfter.trim() !== '' && Number.isInteger(qtyAfterNum) && qtyAfterNum >= 0;
  const qtyDelta =
    detail && qtyAfterValid ? qtyAfterNum - detail.qtyGood : 0;
  const qtyDeltaLabel = qtyDelta > 0 ? `+${qtyDelta}` : String(qtyDelta);
  const qtyChanged = qtyAfterValid && qtyDelta !== 0;
  // Больше, чем раскроено — не запрещаем, но предупреждаем (как на /qc).
  const qtyAboveCut = !!detail && qtyAfterValid && qtyAfterNum > detail.qtyCut;
  const canApplyQtyCorrection =
    !!detail &&
    detail.status === 'IN_PROGRESS' &&
    !detail.pendingQtyCorrection &&
    qtyChanged;

  const submitQtyCorrection = useCallback(async () => {
    if (!canApplyQtyCorrection || busy) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof applyMasterQtyCorrectionAction>>;
    try {
      res = await applyMasterQtyCorrectionAction(
        passport.id,
        qtyAfterNum,
        qtyReason.trim() ? qtyReason.trim() : undefined,
      );
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      const skipped = res.result.salarySkipped;
      onSuccess(
        `Количество обновлено: годных ${res.result.qtyGood}` +
          (skipped > 0
            ? `. ${skipped} строк ЗП уже выплачены — разберите вручную.`
            : ''),
      );
      onClose();
    } else {
      onError(res.error);
    }
  }, [
    busy,
    canApplyQtyCorrection,
    onClose,
    onError,
    onSuccess,
    passport.id,
    qtyAfterNum,
    qtyReason,
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
                  <DefectTypeCreatableSelect
                    id="qc-defect-type"
                    className="master-actions-sheet__input"
                    value={defectTypeId}
                    onValueChange={setDefectTypeId}
                    disabled={busy}
                    disableCreate={busy}
                    defectTypes={defectTypes}
                  />
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

          {action === 'qtyCorrection' &&
            (detail.status !== 'IN_PROGRESS' ? (
              <p className="master-actions-sheet__error" role="alert">
                Паспорт ещё не в работе или уже завершён — корректировать
                количество нельзя.
              </p>
            ) : detail.pendingQtyCorrection ? (
              <p className="master-actions-sheet__error" role="alert">
                По паспорту уже есть заявка ОТК (
                {detail.pendingQtyCorrection.qtyBefore} →{' '}
                {detail.pendingQtyCorrection.qtyAfter}) — подтвердите её во
                вкладке «Корректировки».
              </p>
            ) : (
              <>
                <div className="master-actions-sheet__field">
                  <label
                    className="master-actions-sheet__label"
                    htmlFor="qc-qty-after"
                  >
                    Фактическое количество, шт.{' '}
                    <span className="master-actions-sheet__required">*</span>
                  </label>
                  <input
                    id="qc-qty-after"
                    type="number"
                    className="master-actions-sheet__input"
                    min={0}
                    step={1}
                    value={qtyAfter}
                    onChange={(e) => setQtyAfter(e.target.value)}
                    disabled={busy}
                  />
                  <p className="master-actions-sheet__action-hint">
                    {qtyChanged ? (
                      <>
                        Было <strong>{detail.qtyGood}</strong> → станет{' '}
                        <strong>{qtyAfterNum}</strong> ({qtyDeltaLabel}).
                      </>
                    ) : (
                      'Введите число, отличное от текущих годных.'
                    )}
                    {qtyAboveCut && (
                      <>
                        {' '}
                        <strong>
                          Больше, чем раскроено ({detail.qtyCut}).
                        </strong>{' '}
                        Проверьте.
                      </>
                    )}
                  </p>
                </div>

                <div className="master-actions-sheet__field">
                  <label
                    className="master-actions-sheet__label"
                    htmlFor="qc-qty-reason"
                  >
                    Причина (необязательно)
                  </label>
                  <textarea
                    id="qc-qty-reason"
                    className="master-actions-sheet__textarea"
                    rows={2}
                    maxLength={280}
                    value={qtyReason}
                    onChange={(e) => setQtyReason(e.target.value)}
                    placeholder="Например: пересчитали партию — недостача"
                    disabled={busy}
                  />
                </div>

                <p className="master-actions-sheet__action-hint">
                  Применится сразу: изменит раскроено/годных и пересчитает
                  сдельные начисления.
                </p>

                <button
                  type="button"
                  className="master-actions-sheet__confirm"
                  onClick={submitQtyCorrection}
                  disabled={!canApplyQtyCorrection || busy}
                >
                  {busy ? 'Применяем…' : 'Применить корректировку'}
                </button>
              </>
            ))}
        </>
      )}
    </div>
  );
}

