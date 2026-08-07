'use client';

import type { FormEvent, ReactNode } from 'react';

/**
 * Единый скелет формы внутри AdminModal для модалок ref-create:
 * `<form>` → `.admin-size-plan-modal__body` (error-box + поля) →
 * `.admin-size-plan-modal__footer` («Отмена» / «Добавить»).
 *
 * Submit — прямой вызов inline-action в `onSubmit` хозяина (без
 * useFormState): модалке нужен возвращённый DTO, а не state формы —
 * тот же приём, что в `create-category-window.tsx`.
 */
export function RefModalForm({
  onSubmit,
  onCancel,
  submitting,
  error,
  submitLabel = 'Добавить',
  children,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
  submitLabel?: string;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="admin-form"
      style={{
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
      }}
    >
      <div className="admin-size-plan-modal__body">
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {children}
      </div>
      <footer className="admin-size-plan-modal__footer">
        <div className="admin-size-plan-modal__footer-actions">
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="admin-btn admin-btn--primary"
            disabled={submitting}
          >
            {submitting ? 'Добавление…' : submitLabel}
          </button>
        </div>
      </footer>
    </form>
  );
}
