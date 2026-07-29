'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { AlertTriangle, CheckCircle, Save, ShieldAlert, XCircle } from 'lucide-react';
import {
  OFF_ROUTE_WORK_POLICIES,
  OFF_ROUTE_WORK_POLICY_LABELS,
  type CompanySettingsDto,
  type OffRouteReadinessDto,
} from '@sewing/shared/company-settings';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import { updateOffRoutePolicyAction } from './actions';
import {
  initialUpdateOffRoutePolicyState,
  type UpdateOffRoutePolicyState,
} from './form-state';

/**
 * Секция «Работа мимо маршрута» на `/admin/company-settings`.
 *
 * Управляет строгостью гейта, который отказывает швее, когда она берёт
 * паспорт на операции, отсутствующей в маршруте заказа. Шесть инцидентов
 * с 13.05.2026 начинались одинаково: система принимала такую работу
 * молча, партия шилась до конца и упиралась в AND-гейт перед ОТК недели
 * спустя (28.07 — 70 паспортов в 8 заказах, лаг 27 дней).
 *
 * Почему здесь не голый выпадающий список. Переключение в «Блокировать»
 * с неразобранными шаблонами останавливает цех, а остановка
 * заканчивается требованием выключить проверку насовсем — и второй раз
 * её никто не включит. Весь смысл режима «Предупреждать» в том, чтобы
 * решение принималось ПО ЦИФРАМ, а цифры лежат в `AuditLog` и никому не
 * видны. Поэтому секция показывает счётчик срабатываний за неделю и
 * список того, что помешает включить блокировку.
 *
 * Блокеры НЕ запрещают переключение (решение владельца 29.07.2026):
 * жёсткий запрет в настройках раздражает больше, чем помогает, а
 * владелец может знать контекст, которого система не видит — например,
 * что шаблон всё равно не будет использоваться.
 *
 * Контрол — `select`, а не тумблер: состояний три, у тумблера третьего
 * нет. Тот же аргумент зафиксирован в соседней секции division-overrides.
 *
 * Новую страницу и пункт в сайдбаре сознательно НЕ создаём — вся
 * настройка живёт в уже существующем `/admin/company-settings`.
 */

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Save size={16} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/** Итог по одному блокеру: зелёная галочка или жёлтое предупреждение. */
function ReadinessLine({
  ok,
  children,
}: {
  ok: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={'off-route__check' + (ok ? '' : ' is-warn')}>
      {ok ? (
        <CheckCircle size={16} aria-hidden />
      ) : (
        <AlertTriangle size={16} aria-hidden />
      )}
      <span>{children}</span>
    </li>
  );
}

export function OffRoutePolicySection({
  settings,
  readiness,
}: {
  settings: CompanySettingsDto;
  readiness: OffRouteReadinessDto | null;
}) {
  const [state, formAction] = useFormState<UpdateOffRoutePolicyState, FormData>(
    updateOffRoutePolicyAction,
    initialUpdateOffRoutePolicyState,
  );

  const badTemplates = readiness?.templatesWithArchivedSewing ?? [];

  return (
    <AdminCard>
      <AdminSectionHeader
        title="Работа мимо маршрута"
        hint="что делать, если швея берёт операцию, которой нет в маршруте заказа"
      />
      <div style={{ height: 8 }} />

      <form action={formAction} className="off-route">
        <div className="off-route__control">
          <label className="off-route__label" htmlFor="offRouteWorkPolicy">
            Строгость проверки
          </label>
          <select
            id="offRouteWorkPolicy"
            name="offRouteWorkPolicy"
            defaultValue={settings.offRouteWorkPolicy}
            className="off-route__select"
          >
            {OFF_ROUTE_WORK_POLICIES.map((p) => (
              <option key={p} value={p}>
                {OFF_ROUTE_WORK_POLICY_LABELS[p]}
              </option>
            ))}
          </select>
          <SubmitButton />
        </div>

        <p className="off-route__desc">
          Такая работа не засчитается на ОТК, и партия встанет — обычно это
          обнаруживается через недели, когда паспортов уже десятки.{' '}
          <strong>Предупреждать</strong> — не блокируем, но фиксируем каждый
          случай. <strong>Блокировать</strong> — отказываем швее сразу; обойти
          можно нарядом-допуском мастера.
        </p>

        {readiness && (
          <div className="off-route__readiness">
            <div className="off-route__counter">
              За последние {readiness.windowDays} дн. зафиксировано:{' '}
              <strong>{readiness.incidentsInWindow}</strong>
              {readiness.lastIncidentAt && (
                <span className="off-route__last">
                  {' '}
                  · последний{' '}
                  {new Date(readiness.lastIncidentAt).toLocaleDateString(
                    'ru-RU',
                    {
                      timeZone: 'Europe/Moscow',
                      day: '2-digit',
                      month: '2-digit',
                    },
                  )}
                </span>
              )}
            </div>

            <div className="off-route__readiness-title">
              <ShieldAlert size={16} aria-hidden />
              Готовность к блокировке
            </div>
            <ul className="off-route__checks">
              <ReadinessLine ok={readiness.ordersBlockedFromStart === 0}>
                Заказов, которые не смогут стартовать:{' '}
                <strong>{readiness.ordersBlockedFromStart}</strong>
              </ReadinessLine>
              <ReadinessLine ok={badTemplates.length === 0}>
                Активных шаблонов с архивной швейной операцией:{' '}
                <strong>{badTemplates.length}</strong>
                {badTemplates.length > 0 && (
                  <ul className="off-route__templates">
                    {badTemplates.map((t) => (
                      <li key={t.code}>
                        {t.code} «{t.name}» → {t.operations.join(', ')}
                      </li>
                    ))}
                  </ul>
                )}
              </ReadinessLine>
            </ul>
          </div>
        )}

        {state.error && (
          <p className="form-error">
            <XCircle size={16} aria-hidden /> {state.error}
            {state.errorRequestId ? ` (${state.errorRequestId})` : ''}
          </p>
        )}
        {state.ok && state.successMessage && (
          <p className="form-success">
            <CheckCircle size={16} aria-hidden /> {state.successMessage}
          </p>
        )}
      </form>
    </AdminCard>
  );
}
