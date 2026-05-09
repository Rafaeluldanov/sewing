'use client';

/**
 * Stage 3 «Мастер цеха» — карточка «Ограничения выдачи кроя» в
 * мобильном `/master`.
 *
 * Показывает текущую активную политику (цвет / размер / лимит /
 * `consumedQty / limitQty`) и две крупные кнопки:
 *   - «Установить ограничение» — открывает bottom-sheet форму
 *     (selects цвет/размер + numeric input лимит).
 *   - «Снять ограничение» — мгновенно отключает текущую политику
 *     (`POST /api/cut-release-policy/:id/disable`).
 *
 * Polling обновлённого `consumedQty` идёт через тот же интервал, что
 * и polling вызовов мастера (см. `master-page-client.tsx`) — карточка
 * получает `policy` из родителя и сама не дёргает API в фоне.
 *
 * Mobile-first:
 *   - кнопки по 56+ px;
 *   - bottom-sheet тот же стиль `master-actions-sheet`, что у
 *     `passport-actions-sheet`;
 *   - селект цвета — datalist (без отдельного API), мастер вводит
 *     произвольное значение «как в паспорте» (на MVP именно так и
 *     заведено: цвета — это просто строки в `Passport.color`).
 */

import { useCallback, useState } from 'react';
import { ModalPortal } from '@/components/modal-portal';
import type { CutReleasePolicyDto, SizeDto } from '@sewing/shared';
import {
  disableCutReleasePolicyAction,
  setCutReleasePolicyAction,
} from './cut-release-policy-actions';

interface Props {
  policy: CutReleasePolicyDto | null;
  sizes: SizeDto[];
  knownColors: string[];
  onChanged: (policy: CutReleasePolicyDto | null) => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export function CutReleasePolicyCard({
  policy,
  sizes,
  knownColors,
  onChanged,
  onError,
  onSuccess,
}: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const onDisable = useCallback(async () => {
    if (!policy) return;
    setBusy(true);
    try {
      const res = await disableCutReleasePolicyAction(policy.id);
      if (res.ok) {
        onChanged(res.policy?.isActive ? res.policy : null);
        onSuccess('Ограничение снято');
      } else {
        onError(res.error);
      }
    } finally {
      setBusy(false);
    }
  }, [policy, onChanged, onError, onSuccess]);

  return (
    <section
      className="master-cut-release-card"
      aria-label="Ограничения выдачи кроя"
    >
      <header className="master-cut-release-card__header">
        <h2 className="master-cut-release-card__title">
          Ограничения выдачи кроя
        </h2>
        {policy && (
          <span
            className="master-cut-release-card__badge"
            aria-label="Активное ограничение"
          >
            активно
          </span>
        )}
      </header>

      {policy ? (
        <ActiveSummary policy={policy} />
      ) : (
        <p className="master-cut-release-card__empty">
          Ограничений нет — сотрудники могут брать любой крой.
        </p>
      )}

      <div className="master-cut-release-card__actions">
        <button
          type="button"
          className="master-cut-release-card__primary"
          onClick={() => setFormOpen(true)}
          disabled={busy}
        >
          {policy ? 'Изменить ограничение' : 'Установить ограничение'}
        </button>
        {policy && (
          <button
            type="button"
            className="master-cut-release-card__secondary"
            onClick={onDisable}
            disabled={busy}
          >
            {busy ? 'Снимаем…' : 'Снять ограничение'}
          </button>
        )}
      </div>

      {formOpen && (
        <CutReleasePolicyForm
          sizes={sizes}
          knownColors={knownColors}
          initial={policy}
          onClose={() => setFormOpen(false)}
          onSaved={(next) => {
            onChanged(next);
            onSuccess('Ограничение сохранено');
            setFormOpen(false);
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

function ActiveSummary({ policy }: { policy: CutReleasePolicyDto }) {
  return (
    <dl className="master-cut-release-card__summary">
      <div className="master-cut-release-card__row">
        <dt>Цвет</dt>
        <dd>{policy.color ?? 'любой'}</dd>
      </div>
      <div className="master-cut-release-card__row">
        <dt>Размер</dt>
        <dd>{policy.sizeLabel ?? 'любой'}</dd>
      </div>
      <div className="master-cut-release-card__row">
        <dt>Лимит</dt>
        <dd>
          <strong>{policy.consumedQty}</strong>
          {' / '}
          {policy.limitQty} шт.
        </dd>
      </div>
    </dl>
  );
}

interface FormProps {
  sizes: SizeDto[];
  knownColors: string[];
  initial: CutReleasePolicyDto | null;
  onClose: () => void;
  onSaved: (policy: CutReleasePolicyDto | null) => void;
  onError: (msg: string) => void;
}

function CutReleasePolicyForm({
  sizes,
  knownColors,
  initial,
  onClose,
  onSaved,
  onError,
}: FormProps) {
  const [color, setColor] = useState(initial?.color ?? '');
  const [sizeId, setSizeId] = useState(initial?.sizeId ?? '');
  const [limitText, setLimitText] = useState(
    initial?.limitQty != null ? String(initial.limitQty) : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = useCallback(async () => {
    setFormError(null);
    const limitQty = Number.parseInt(limitText, 10);
    if (!Number.isFinite(limitQty) || limitQty < 1) {
      setFormError('Лимит должен быть целым числом не меньше 1');
      return;
    }
    setSubmitting(true);
    try {
      const res = await setCutReleasePolicyAction({
        color: color.trim() === '' ? null : color.trim(),
        sizeId: sizeId === '' ? null : sizeId,
        limitQty,
      });
      if (res.ok) {
        onSaved(res.policy);
      } else {
        setFormError(res.error);
        onError(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  }, [color, sizeId, limitText, onSaved, onError]);

  const canSubmit = limitText.trim().length > 0 && !submitting;

  return (
    <ModalPortal>
    <div
      className="master-actions-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Установить ограничение выдачи кроя"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="master-actions-sheet__card">
        <div className="master-actions-sheet__header">
          <div>
            <h3 className="master-actions-sheet__title">
              Ограничение выдачи кроя
            </h3>
            <p className="master-actions-sheet__subtitle">
              Сотрудники на первой операции маршрута смогут брать только
              подходящий крой и не больше лимита.
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
        </div>

        <div className="master-actions-sheet__body">
          <div className="master-actions-sheet__field">
            <label
              className="master-actions-sheet__label"
              htmlFor="cut-release-color"
            >
              Цвет
            </label>
            <input
              id="cut-release-color"
              className="master-actions-sheet__input"
              list="cut-release-color-list"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="Любой цвет"
              autoComplete="off"
            />
            <datalist id="cut-release-color-list">
              {knownColors.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>

          <div className="master-actions-sheet__field">
            <label
              className="master-actions-sheet__label"
              htmlFor="cut-release-size"
            >
              Размер
            </label>
            <select
              id="cut-release-size"
              className="master-actions-sheet__input"
              value={sizeId}
              onChange={(e) => setSizeId(e.target.value)}
            >
              <option value="">Любой размер</option>
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </div>

          <div className="master-actions-sheet__field">
            <label
              className="master-actions-sheet__label"
              htmlFor="cut-release-limit"
            >
              Лимит, шт.{' '}
              <span className="master-actions-sheet__required">*</span>
            </label>
            <input
              id="cut-release-limit"
              className="master-actions-sheet__input"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
              placeholder="Например, 100"
            />
          </div>

          {formError && (
            <p className="master-actions-sheet__error" role="alert">
              {formError}
            </p>
          )}

          <button
            type="button"
            className="master-actions-sheet__confirm"
            onClick={onSubmit}
            disabled={!canSubmit}
          >
            {submitting ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
