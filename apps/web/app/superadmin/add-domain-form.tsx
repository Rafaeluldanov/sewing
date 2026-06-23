'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { addDomainAction } from './actions';
import { initialAddDomainState } from './form-state';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      {pending ? 'Добавляю…' : 'Добавить домен'}
    </button>
  );
}

export function AddDomainForm({ tenantId }: { tenantId: string }) {
  // bind tenantId — server action принимает (tenantId, prev, formData).
  const [state, formAction] = useFormState(
    addDomainAction.bind(null, tenantId),
    initialAddDomainState,
  );
  return (
    <form
      action={formAction}
      className="admin-form"
      style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
    >
      <label className="admin-field" style={{ flex: 1 }}>
        <span>Новый домен</span>
        <input name="host" placeholder="client.dev.teeon.ru" required />
      </label>
      <Submit />
      {state.error && (
        <div className="error-box" role="alert" style={{ flexBasis: '100%' }}>
          {state.error}
        </div>
      )}
    </form>
  );
}
