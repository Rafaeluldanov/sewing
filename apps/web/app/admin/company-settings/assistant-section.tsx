'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  Bot,
  CheckCircle,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  ASSISTANT_MODELS,
  ASSISTANT_SCOPE_LABELS,
} from '@sewing/shared/assistant';
import type { IntegrationSettingsDto } from '@sewing/shared/integration';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import {
  testAssistantKeyAction,
  updateAssistantSettingsAction,
} from './assistant-actions';
import {
  initialTestAssistantKeyState,
  initialUpdateAssistantSettingsState,
  type TestAssistantKeyState,
  type UpdateAssistantSettingsState,
} from './assistant-form-state';

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function TestKeyButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
    >
      <RefreshCw size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Проверяем…' : 'Проверить ключ'}
    </button>
  );
}

/** Статус из СОХРАНЁННЫХ настроек — не из текущих правок формы. */
function StatusBanner({ settings }: { settings: IntegrationSettingsDto }) {
  const lastOk = settings.assistantLastCheckOkAt
    ? new Date(settings.assistantLastCheckOkAt).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
      })
    : null;

  if (!settings.assistantEnabled) {
    return (
      <div className="admin-integration-status admin-integration-status--off">
        <Bot size={16} strokeWidth={1.6} aria-hidden />
        Ассистент выключен
      </div>
    );
  }
  if (settings.assistantLastCheckError) {
    return (
      <div className="admin-integration-status admin-integration-status--error">
        <XCircle size={16} strokeWidth={1.6} aria-hidden />
        Последняя проверка не удалась: {settings.assistantLastCheckError}
      </div>
    );
  }
  const source =
    settings.assistantKeySource === 'OWN' ? 'свой ключ' : 'платформенный ключ';
  if (lastOk) {
    return (
      <div className="admin-integration-status admin-integration-status--ok">
        <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
        Включён · {source} · проверен {lastOk} (МСК)
      </div>
    );
  }
  return (
    <div className="admin-integration-status admin-integration-status--warn">
      <RefreshCw size={16} strokeWidth={1.6} aria-hidden />
      Включён · {source} · ключ ещё не проверялся
    </div>
  );
}

/** Расход с начала месяца — рядом с потолком, иначе потолок настраивают вслепую. */
function SpendMeter({ settings }: { settings: IntegrationSettingsDto }) {
  const spent = settings.assistantSpentThisMonthCents / 100;
  const budget = settings.assistantMonthlyBudgetCents / 100;
  const pct =
    budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;

  return (
    <div className="admin-assistant-spend">
      <div className="admin-assistant-spend__top">
        <span>Израсходовано в этом месяце</span>
        <b>
          ${spent.toFixed(2)}
          {budget > 0 ? ` из $${budget.toFixed(2)}` : ' (без потолка)'} ·{' '}
          {settings.assistantQuestionsThisMonth} вопрос(ов)
        </b>
      </div>
      {budget > 0 && (
        <div
          className="admin-assistant-spend__bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="admin-assistant-spend__fill"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ScopeToggle({
  name,
  scope,
  defaultChecked,
}: {
  name: string;
  scope: keyof typeof ASSISTANT_SCOPE_LABELS;
  defaultChecked: boolean;
}) {
  const { title, hint } = ASSISTANT_SCOPE_LABELS[scope];
  return (
    <label className="admin-toggle-row">
      <span className="admin-toggle-row__text">
        <strong>{title}</strong>
        <span className="admin-field__hint">{hint}</span>
      </span>
      <span className="admin-switch">
        <input type="hidden" name={`${name}__present`} value="1" />
        <input type="checkbox" name={name} defaultChecked={defaultChecked} />
        <span className="admin-switch__track" aria-hidden />
        <span className="admin-switch__thumb" aria-hidden />
      </span>
    </label>
  );
}

function SettingsForm({ settings }: { settings: IntegrationSettingsDto }) {
  const [state, formAction] = useFormState<
    UpdateAssistantSettingsState,
    FormData
  >(updateAssistantSettingsAction, initialUpdateAssistantSettingsState);

  // Поле ключа нужно только при «своём» ключе. Держим в state, чтобы
  // подсказка и доступность поля менялись сразу, без сохранения формы.
  const [keySource, setKeySource] = useState(settings.assistantKeySource);

  return (
    <form action={formAction} className="admin-stack" style={{ gap: 14 }}>
      <label className="admin-toggle-row">
        <span className="admin-toggle-row__text">
          <strong>Ассистент включён</strong>
          <span className="admin-field__hint">
            Выключен — окно «Спросить» не показывается, запросы наружу не
            уходят.
          </span>
        </span>
        <span className="admin-switch">
          {/* hidden-marker: браузер не шлёт unchecked-checkbox */}
          <input type="hidden" name="assistantEnabled__present" value="1" />
          <input
            type="checkbox"
            name="assistantEnabled"
            defaultChecked={settings.assistantEnabled}
          />
          <span className="admin-switch__track" aria-hidden />
          <span className="admin-switch__thumb" aria-hidden />
        </span>
      </label>

      <div className="admin-subhead">Доступ к модели</div>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="assistant-key-source">Источник ключа</label>
          <select
            id="assistant-key-source"
            name="assistantKeySource"
            defaultValue={settings.assistantKeySource}
            onChange={(e) =>
              setKeySource(e.target.value as IntegrationSettingsDto['assistantKeySource'])
            }
          >
            <option value="PLATFORM">Платформенный ключ</option>
            <option value="OWN">Свой ключ Anthropic</option>
          </select>
          <span className="admin-field__hint">
            {keySource === 'OWN'
              ? 'Компания платит за обращения сама.'
              : settings.platformAssistantKeyAvailable
                ? 'Ключ задан на сервере (ANTHROPIC_API_KEY). Платит владелец платформы.'
                : 'На сервере не задан ANTHROPIC_API_KEY — включить не получится.'}
          </span>
        </div>

        <div className="admin-field">
          <label htmlFor="assistant-api-key">Ключ Anthropic</label>
          <input
            id="assistant-api-key"
            name="assistantApiKey"
            type="password"
            maxLength={300}
            disabled={keySource !== 'OWN'}
            placeholder={
              keySource !== 'OWN'
                ? 'не требуется'
                : settings.hasOwnAssistantKey
                  ? '•••••••• (оставьте пустым, чтобы не менять)'
                  : 'sk-ant-…'
            }
            autoComplete="new-password"
          />
          <span className="admin-field__hint">
            Хранится в зашифрованном виде. Наружу не показывается.
          </span>
        </div>

        <div className="admin-field">
          <label htmlFor="assistant-model">Модель</label>
          <select
            id="assistant-model"
            name="assistantModel"
            defaultValue={settings.assistantModel}
          >
            {ASSISTANT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="admin-field__hint">
            {ASSISTANT_MODELS.find((m) => m.id === settings.assistantModel)
              ?.hint ?? 'Влияет на стоимость обращения.'}
          </span>
        </div>
      </div>

      <div className="admin-subhead">Лимиты</div>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="assistant-daily-limit">
            Вопросов в день на сотрудника
          </label>
          <input
            id="assistant-daily-limit"
            name="assistantDailyLimitPerUser"
            type="number"
            min={0}
            max={1000}
            step={1}
            defaultValue={settings.assistantDailyLimitPerUser}
          />
          <span className="admin-field__hint">
            Исчерпан — ассистент отказывает до полуночи по Москве. 0 — без
            лимита.
          </span>
        </div>
        <div className="admin-field">
          <label htmlFor="assistant-budget">Потолок расхода в месяц, $</label>
          <input
            id="assistant-budget"
            name="assistantMonthlyBudgetUsd"
            type="number"
            min={0}
            step="0.01"
            defaultValue={(settings.assistantMonthlyBudgetCents / 100).toFixed(2)}
          />
          <span className="admin-field__hint">
            Достигнут — ассистент перестаёт отвечать до следующего месяца. 0 —
            без потолка.
          </span>
        </div>
      </div>

      <SpendMeter settings={settings} />

      <div className="admin-subhead">Что ассистент может читать</div>
      <ScopeToggle
        name="assistantScopeProduction"
        scope="PRODUCTION"
        defaultChecked={settings.assistantScopeProduction}
      />
      <ScopeToggle
        name="assistantScopeSupply"
        scope="SUPPLY"
        defaultChecked={settings.assistantScopeSupply}
      />
      <ScopeToggle
        name="assistantScopeMoney"
        scope="MONEY"
        defaultChecked={settings.assistantScopeMoney}
      />
      <ScopeToggle
        name="assistantScopePayroll"
        scope="PAYROLL"
        defaultChecked={settings.assistantScopePayroll}
      />

      <p className="admin-note">
        <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />
        Тумблеры только сужают: они закрывают целый класс данных для всех. Кто
        что видит внутри разрешённого — по-прежнему решает матрица доступов в
        разделе «Персонал».
      </p>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-actions-row">
        <SaveButton />
      </div>
    </form>
  );
}

/** Блок «Проверить ключ» + итог проверки. */
function KeyCheck() {
  const [state, formAction] = useFormState<TestAssistantKeyState, FormData>(
    testAssistantKeyAction,
    initialTestAssistantKeyState,
  );

  return (
    <div className="admin-stack" style={{ gap: 10 }}>
      <div className="admin-subhead">Проверка ключа</div>
      <div className="admin-actions-row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <form action={formAction}>
          <TestKeyButton />
        </form>
        <span className="admin-field__hint">
          Проверка использует сохранённые настройки — сначала сохраните
          изменения.
        </span>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.result && state.result.ok && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.result.message}
        </div>
      )}
      {state.result && !state.result.ok && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.result.message}
        </div>
      )}
    </div>
  );
}

/**
 * Карточка-секция «Ассистент (ИИ)» на вкладке «Интеграции»
 * (`/admin/company-settings?tab=integrations`), под флагом
 * `FEATURE_AI_ASSISTANT` (см. `apps/web/lib/feature-flags.ts`).
 *
 * Этап 0: ассистент только читает. Настройки живут в той же
 * singleton-строке `IntegrationSettings`, что и связка с upgifts —
 * отдельного раздела фича не заводит.
 */
export function AssistantSection({
  settings,
}: {
  settings: IntegrationSettingsDto;
}) {
  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<KeyRound size={18} strokeWidth={1.6} aria-hidden />}
        title="Ассистент (ИИ)"
        hint="Окно «Спросить» в админке — отвечает по вашим данным, ничего не меняет"
      />

      <StatusBanner settings={settings} />
      <SettingsForm settings={settings} />
      <hr className="admin-hr" />
      <KeyCheck />
    </AdminCard>
  );
}
