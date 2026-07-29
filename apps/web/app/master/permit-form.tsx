'use client';

/**
 * Форма выдачи наряда-допуска прямо в строке «Расхождений».
 *
 * Почему здесь. Строка расхождения — это уже готовая пара «заказ ×
 * операция», то есть ровно тело допуска. Мастеру остаётся ответить на
 * ОДИН вопрос, который система за него решить не может: какой шаг
 * маршрута эта работа закрывает. Отправлять его за этим на отдельный
 * экран — значит гарантировать, что он туда не пойдёт и вместо допуска
 * попросит «выключить эту вашу проверку».
 *
 * Поле «какой шаг закрывает» обязательное и намеренно первое. Допуск без
 * него — это инцидент 28.07.2026 с бумажкой: швея дошьёт, а паспорт всё
 * равно не закроет шаг маршрута, и AND-гейт перед ОТК всё равно уронит
 * партию, просто неделей позже.
 */

import { useState } from 'react';
import type { RouteDivergenceDto } from '@sewing/shared';
import { issueRouteWorkPermitAction } from './production-board-actions';

export function PermitForm({
  item,
  onDone,
  onCancel,
}: {
  item: RouteDivergenceDto;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [satisfiesStepOperationId, setStep] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(12);
  const [qtyLimit, setQtyLimit] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    satisfiesStepOperationId.length > 0 && reason.trim().length >= 3 && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await issueRouteWorkPermitAction({
      orderId: item.orderId,
      operationId: item.operationId,
      satisfiesStepOperationId,
      reason: reason.trim(),
      hours,
      qtyLimit: qtyLimit.trim() === '' ? null : Number(qtyLimit),
    });
    setBusy(false);
    if (res.ok) {
      onDone(
        `Допуск выдан: «${res.data.operationCode} ${res.data.operationName}» закрывает «${res.data.satisfiesStepOperationCode} ${res.data.satisfiesStepOperationName}».`,
      );
    } else {
      setError(res.error);
    }
  }

  return (
    <div className="permit-form">
      <div className="permit-form__row">
        <label className="permit-form__label" htmlFor="permit-step">
          Какой шаг маршрута закрывает эта работа
        </label>
        <select
          id="permit-step"
          className="permit-form__control"
          value={satisfiesStepOperationId}
          onChange={(e) => setStep(e.target.value)}
        >
          <option value="">— выберите шаг —</option>
          {item.routeSewingSteps.map((s) => (
            <option key={s.operationId} value={s.operationId}>
              {s.operationCode} {s.operationName}
            </option>
          ))}
        </select>
        <p className="permit-form__hint">
          Без этого допуск бесполезен: работа не засчитается, и заказ всё
          равно встанет на ОТК.
        </p>
      </div>

      <div className="permit-form__row">
        <label className="permit-form__label" htmlFor="permit-reason">
          Причина
        </label>
        <input
          id="permit-reason"
          className="permit-form__control"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например: сломан станок подгибки, шьём на распошивалке"
        />
      </div>

      <div className="permit-form__grid">
        <div className="permit-form__row">
          <label className="permit-form__label" htmlFor="permit-hours">
            Срок, часов
          </label>
          <input
            id="permit-hours"
            className="permit-form__control"
            type="number"
            min={1}
            max={72}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          />
          <p className="permit-form__hint">
            12 ч — одна смена. Допуск, доживший до второй, закрывают правкой
            маршрута, а не продлением.
          </p>
        </div>
        <div className="permit-form__row">
          <label className="permit-form__label" htmlFor="permit-qty">
            Лимит изделий
          </label>
          <input
            id="permit-qty"
            className="permit-form__control"
            type="number"
            min={1}
            value={qtyLimit}
            onChange={(e) => setQtyLimit(e.target.value)}
            placeholder="без лимита"
          />
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="permit-form__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {busy ? 'Выдаём…' : 'Выдать допуск'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Отмена
        </button>
      </div>
    </div>
  );
}
