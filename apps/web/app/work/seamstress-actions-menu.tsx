'use client';

/**
 * Скрытое меню действий для швеи на /work.
 *
 * Большая красная кнопка «Завершить смену» убрана с основного экрана
 * (повышала риск случайного нажатия и ломала clean mobile UX). Все
 * редкие/опасные действия теперь сложены под три-точечную кнопку в
 * правом верхнем углу:
 *
 *   - «Завершить смену» (видна только если смена активна) — c явным
 *     `confirm()` шагом, чтобы остался осознанный жест;
 *   - «Выйти» — заменяет logout из тёмной шапки, которая на /work у
 *     швеи теперь не рендерится (см. `components/app-header.tsx`).
 *
 * Бизнес-логика shift-end не меняется: вызываем тот же серверный
 * action `stopShiftAction`, который дёргает `POST /shifts/stop` и
 * `revalidatePath('/work')` — поведение/счётчики/выработка остаются
 * как были.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { logoutAction } from '@/app/(auth)/logout-action';
import { stopShiftAction } from './actions';
import { initialWorkFormState } from './state';

interface Props {
  /**
   * Активна ли сейчас смена. Только в этом случае показываем
   * пункт «Завершить смену» — без активной смены он бессмыслен и
   * вернул бы 4xx от API.
   */
  shiftActive: boolean;
}

function StopShiftButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="seamstress-actions__item seamstress-actions__item--danger"
      disabled={pending}
      onClick={(e) => {
        // Двойной щелчок защиты: пункт уже спрятан в меню, но stop
        // отменить нельзя (выработка фиксируется на бэке), поэтому
        // просим явное подтверждение.
        if (
          !window.confirm(
            'Завершить смену? Текущие незакрытые крои останутся в работе.',
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      {pending ? 'Завершение…' : 'Завершить смену'}
    </button>
  );
}

export function SeamstressActionsMenu({ shiftActive }: Props) {
  const [open, setOpen] = useState(false);
  const [stopState, stopAction] = useFormState(
    stopShiftAction,
    initialWorkFormState,
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('touchstart', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('touchstart', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Если после успешного stopShiftAction серверный rerender ещё не
  // приехал, закрываем меню сами — иначе на мобиле остаётся висеть
  // открытая панелька поверх обновлённого состояния.
  useEffect(() => {
    if (stopState.info) setOpen(false);
  }, [stopState.info]);

  return (
    <div className="seamstress-actions" ref={wrapRef}>
      <button
        type="button"
        className="seamstress-actions__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Меню действий"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>⋯</span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="seamstress-actions__menu"
          aria-label="Действия швеи"
        >
          {shiftActive && (
            <form action={stopAction} role="none">
              <StopShiftButton />
            </form>
          )}
          <form action={logoutAction} role="none">
            <button
              type="submit"
              className="seamstress-actions__item"
              role="menuitem"
            >
              Выйти
            </button>
          </form>
          {stopState.error && (
            <div className="seamstress-actions__error" role="alert">
              {stopState.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
