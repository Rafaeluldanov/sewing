'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { AlertCircle, Copy, Eye, EyeOff, KeyRound } from 'lucide-react';
import type { EmployeeDetailDto } from '@sewing/shared/employees';
import { revealEmployeePinAction, updateEmployeePinAction } from '../actions';
import {
  initialUpdateEmployeePinState,
  type RevealEmployeePinState,
  type UpdateEmployeePinState,
} from '../form-state';

/**
 * Показ и смена PIN сотрудника в карточке `/admin/employees/[id]`.
 *
 * До этих компонентов забытый PIN лечился только сбросом: в БД лежал
 * единственный, необратимый bcrypt-хеш. Менеджеру же чаще нужно не
 * сменить код, а продиктовать его — смена ломает уже розданные бумажки
 * и заученное. Поэтому PIN хранится ещё и обратимо (`Employee.pinEnc`,
 * AES-256-GCM), а карточка умеет его показать.
 *
 * Показ — по явному нажатию и всегда через сервер: каждый просмотр
 * пишется в аудит (`EMPLOYEE_PIN_VIEWED`), поэтому подтягивать PIN в
 * RSC при рендере страницы нельзя — журнал заполнился бы просмотрами,
 * которых не было.
 */

/**
 * Общее состояние показанного PIN'а на двух разнесённых блоках
 * («Доступ» и «Смена PIN»).
 *
 * Разнесены они намеренно (см. `EmployeePinForm`), но состояние у них
 * общее — иначе после успешной смены блок «Доступ» продолжал бы
 * показывать ПРЕДЫДУЩИЙ код: `revalidatePath` перерисовывает серверную
 * часть, а локальный `useState` клиентского компонента переживает
 * ревалидацию. Менеджер бы диктовал человеку код, который уже не пускает.
 */
const RevealedPinContext = createContext<{
  revealed: RevealEmployeePinState | null;
  setRevealed: (next: RevealEmployeePinState | null) => void;
}>({ revealed: null, setRevealed: () => {} });

export function EmployeePinProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [revealed, setRevealed] = useState<RevealEmployeePinState | null>(null);
  const value = useMemo(() => ({ revealed, setRevealed }), [revealed]);
  return (
    <RevealedPinContext.Provider value={value}>
      {children}
    </RevealedPinContext.Provider>
  );
}

/** Строка «PIN» в блоке «Доступ»: кнопка «Показать» → код + копирование. */
export function EmployeePinReveal({
  employee,
}: {
  employee: EmployeeDetailDto;
}) {
  const { revealed, setRevealed } = useContext(RevealedPinContext);
  const [pending, startTransition] = useTransition();
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>(
    'idle',
  );

  // `hasStoredPin` опционально в DTO ради backward-compat: у старого
  // backend'а ключа нет вовсе. Тогда не гадаем, а даём нажать — сервер
  // ответит честной причиной.
  const revealable = employee.hasStoredPin !== false;
  const pin = revealed?.pin ?? null;

  /**
   * Копирование в буфер. `navigator.clipboard` есть только в
   * secure context: dev-стенд открывают по LAN на `http://…:3000`, и
   * там объекта просто нет. Молчаливый no-op здесь недопустим — речь
   * о выдаче учётных данных, менеджер обязан понимать, скопировалось
   * или диктовать с экрана.
   */
  async function copyPin(value: string) {
    try {
      if (!window.isSecureContext || !navigator.clipboard) {
        setCopyState('failed');
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopyState('done');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <span className="admin-pin-reveal">
      {/* Кнопка НЕ размонтируется при показе — только меняет подпись.
          Иначе после нажатия фокус улетает на <body>, и следующий Tab
          начинает обход с начала документа. По той же причине вместо
          `disabled` на время запроса — `aria-busy`. */}
      <button
        type="button"
        className="admin-btn admin-btn--sm"
        aria-expanded={pin !== null}
        aria-busy={pending}
        onClick={() => {
          if (pin !== null) {
            setRevealed(null);
            setCopyState('idle');
            return;
          }
          startTransition(async () => {
            setCopyState('idle');
            setRevealed(await revealEmployeePinAction(employee.id));
          });
        }}
      >
        {pin !== null ? (
          <EyeOff size={14} strokeWidth={1.6} aria-hidden />
        ) : (
          <Eye size={14} strokeWidth={1.6} aria-hidden />
        )}
        {pin !== null ? 'Скрыть' : pending ? 'Показываем…' : 'Показать'}
      </button>

      {pin !== null && (
        <>
          <code className="admin-pin-reveal__value">{pin}</code>
          <button
            type="button"
            className="admin-btn admin-btn--sm"
            onClick={() => void copyPin(pin)}
          >
            <Copy size={14} strokeWidth={1.6} aria-hidden />
            Скопировать
          </button>
        </>
      )}

      {/* Один постоянный live-регион на все исходы. Постоянный —
          потому что вставка нового элемента с `aria-live` скринридером
          не озвучивается; регион должен быть в DOM заранее. */}
      <span
        role="status"
        aria-live="polite"
        className={
          revealed?.error
            ? 'admin-pin-reveal__error'
            : 'admin-muted admin-pin-reveal__hint'
        }
      >
        {revealed?.error
          ? revealed.error
          : revealed?.notice
          ? revealed.notice
          : copyState === 'done'
          ? 'PIN скопирован в буфер обмена'
          : copyState === 'failed'
          ? 'Скопировать не удалось — продиктуйте код с экрана'
          : pin !== null
          ? 'PIN показан'
          : !revealable
          ? 'задан до включения показа — читается только после смены'
          : ''}
      </span>

      {revealed?.error && revealed.errorRequestId && (
        <span className="admin-muted admin-pin-reveal__hint">
          req: <code>{revealed.errorRequestId}</code>
        </span>
      )}
    </span>
  );
}

function ChangePinButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <KeyRound size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Меняем…' : 'Сменить PIN'}
    </button>
  );
}

/**
 * Смена PIN — отдельной формой, а не полем в «Оплате за смену».
 *
 * Отдельной сознательно (тот же приём, что в карточке display-экрана):
 * сохранение ставки не должно иметь ни малейшего шанса сбросить код, по
 * которому человек логинится в цехе. Поле повтора — защита от опечатки:
 * ошибку заметят уже у станка, когда сотрудник не сможет открыть смену.
 */
export function EmployeePinForm({ employee }: { employee: EmployeeDetailDto }) {
  const { setRevealed } = useContext(RevealedPinContext);
  const action = updateEmployeePinAction.bind(null, employee.id);

  // Обёртка над action'ом: гасим показанный ранее PIN в блоке «Доступ»
  // сразу, как код сменился. Иначе там висел бы старый — тот, что уже
  // не пускает.
  const actionWithReset = useCallback(
    async (prev: UpdateEmployeePinState, form: FormData) => {
      const next = await action(prev, form);
      if (next.ok) setRevealed(null);
      return next;
    },
    [action, setRevealed],
  );

  const [state, formAction] = useFormState<UpdateEmployeePinState, FormData>(
    actionWithReset,
    initialUpdateEmployeePinState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="emp-edit-pin">Новый PIN</label>
          <input
            id="emp-edit-pin"
            name="pin"
            type="text"
            minLength={4}
            maxLength={100}
            placeholder="не менее 4 символов"
            required
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="emp-edit-pin-repeat">Повторите PIN</label>
          <input
            id="emp-edit-pin-repeat"
            name="pinRepeat"
            type="text"
            minLength={4}
            maxLength={100}
            placeholder="ещё раз"
            required
            autoComplete="off"
          />
        </div>
      </div>

      <div className="admin-actions-row">
        <ChangePinButton />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">
            <AlertCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
          </div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          {state.successMessage}
        </div>
      )}
    </form>
  );
}
