'use client';

/**
 * `PostMaterialIssueButton` — inline-действие «Провести» для строки
 * DRAFT-документа расхода в таблице `MaterialIssuesTable`
 * (см. `apps/web/components/orders/material-issues/*`).
 *
 * Сабмитит пустую форму через server action
 * `postMaterialIssueAction`. После успеха родительский RSC
 * перечитает список через `revalidatePath` — DRAFT-строка исчезнет,
 * POSTED-строка появится без действий.
 */
import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, XCircle } from 'lucide-react';
import { postMaterialIssueAction } from '@/app/admin/orders/[id]/material-issues-actions';
import { initialMaterialIssueFormState } from '@/app/admin/orders/[id]/material-issues-form-state';

interface Props {
  orderId: string;
  id: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
      style={{ fontSize: '0.78rem', padding: '4px 8px' }}
    >
      <CheckCircle size={12} strokeWidth={1.6} aria-hidden />
      {pending ? 'Проводим…' : 'Провести'}
    </button>
  );
}

export function PostMaterialIssueButton({ orderId, id }: Props) {
  const [state, formAction] = useFormState(
    postMaterialIssueAction.bind(null, orderId, id),
    initialMaterialIssueFormState,
  );

  return (
    <form action={formAction} style={{ display: 'inline-flex' }}>
      <SubmitButton />
      {state.error && (
        <div
          className="error-box"
          role="alert"
          style={{ marginLeft: 6, fontSize: '0.75rem' }}
        >
          <XCircle size={12} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
    </form>
  );
}
