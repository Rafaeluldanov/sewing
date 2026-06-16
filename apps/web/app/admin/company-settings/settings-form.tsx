'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import type { CompanySettingsDto } from '@sewing/shared/company-settings';
import {
  COMPANY_SETTINGS_NAME_MAX_LENGTH,
  COMPANY_SETTINGS_SHORT_NAME_MAX_LENGTH,
  COMPANY_SETTINGS_PREFIX_MAX_LENGTH,
  COMPANY_SETTINGS_ADDRESS_MAX_LENGTH,
  COMPANY_SETTINGS_PHONE_MAX_LENGTH,
  COMPANY_SETTINGS_EMAIL_MAX_LENGTH,
  COMPANY_SETTINGS_PERSON_MAX_LENGTH,
  COMPANY_SETTINGS_BANK_NAME_MAX_LENGTH,
} from '@sewing/shared/company-settings';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import { updateCompanySettingsAction } from './actions';
import {
  initialUpdateCompanySettingsState,
  type UpdateCompanySettingsState,
} from './form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/**
 * Единая форма для всех трёх блоков реквизитов («Реквизиты
 * организации», «Контакты и руководители», «Банковские реквизиты»).
 *
 * Все поля идут в один PATCH `/api/company-settings` — backend
 * принимает любое подмножество и пишет один аудит-event на изменение
 * (см. `CompanySettingsService.update`). Это сознательно проще, чем
 * три отдельные формы: меньше дублирования, и менеджер может
 * заполнить всё сразу.
 *
 * Структура: визуально три карточки с `AdminSectionHeader`, но всё
 * внутри одного `<form>`, чтобы один Submit отправил весь diff.
 */
export function CompanySettingsForm({
  settings,
}: {
  settings: CompanySettingsDto;
}) {
  const [state, formAction] = useFormState<
    UpdateCompanySettingsState,
    FormData
  >(updateCompanySettingsAction, initialUpdateCompanySettingsState);

  return (
    <form action={formAction} className="admin-form admin-stack">
      <AdminCard>
        <AdminSectionHeader title="Реквизиты организации" />
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="company-legalName">Полное название</label>
            <input
              id="company-legalName"
              name="legalName"
              type="text"
              defaultValue={settings.legalName ?? ''}
              maxLength={COMPANY_SETTINGS_NAME_MAX_LENGTH}
              placeholder="ООО «Швейная фабрика»"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-shortName">Краткое название</label>
            <input
              id="company-shortName"
              name="shortName"
              type="text"
              defaultValue={settings.shortName ?? ''}
              maxLength={COMPANY_SETTINGS_SHORT_NAME_MAX_LENGTH}
              placeholder="ШФ-1"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-prefix">Префикс</label>
            <input
              id="company-prefix"
              name="prefix"
              type="text"
              defaultValue={settings.prefix ?? ''}
              maxLength={COMPANY_SETTINGS_PREFIX_MAX_LENGTH}
              placeholder="ШФ"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-inn">ИНН</label>
            <input
              id="company-inn"
              name="inn"
              type="text"
              inputMode="numeric"
              defaultValue={settings.inn ?? ''}
              maxLength={12}
              placeholder="10 или 12 цифр"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-kpp">КПП</label>
            <input
              id="company-kpp"
              name="kpp"
              type="text"
              inputMode="numeric"
              defaultValue={settings.kpp ?? ''}
              maxLength={9}
              placeholder="9 цифр"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-ogrn">ОГРН / ОГРНИП</label>
            <input
              id="company-ogrn"
              name="ogrn"
              type="text"
              inputMode="numeric"
              defaultValue={settings.ogrn ?? ''}
              maxLength={15}
              placeholder="13 или 15 цифр"
            />
          </div>
        </div>
        <div className="admin-field">
          <label htmlFor="company-legalAddress">Юридический адрес</label>
          <textarea
            id="company-legalAddress"
            name="legalAddress"
            defaultValue={settings.legalAddress ?? ''}
            maxLength={COMPANY_SETTINGS_ADDRESS_MAX_LENGTH}
            rows={2}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="company-actualAddress">Фактический адрес</label>
          <textarea
            id="company-actualAddress"
            name="actualAddress"
            defaultValue={settings.actualAddress ?? ''}
            maxLength={COMPANY_SETTINGS_ADDRESS_MAX_LENGTH}
            rows={2}
          />
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Контакты и руководители" />
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="company-phone">Телефон</label>
            <input
              id="company-phone"
              name="phone"
              type="text"
              defaultValue={settings.phone ?? ''}
              maxLength={COMPANY_SETTINGS_PHONE_MAX_LENGTH}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-email">Email</label>
            <input
              id="company-email"
              name="email"
              type="email"
              defaultValue={settings.email ?? ''}
              maxLength={COMPANY_SETTINGS_EMAIL_MAX_LENGTH}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-directorName">ФИО руководителя</label>
            <input
              id="company-directorName"
              name="directorName"
              type="text"
              defaultValue={settings.directorName ?? ''}
              maxLength={COMPANY_SETTINGS_PERSON_MAX_LENGTH}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-accountantName">
              ФИО главного бухгалтера
            </label>
            <input
              id="company-accountantName"
              name="accountantName"
              type="text"
              defaultValue={settings.accountantName ?? ''}
              maxLength={COMPANY_SETTINGS_PERSON_MAX_LENGTH}
            />
          </div>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Материалы и склад" />
        {/*
          Hidden-marker-ы, чтобы server action мог отличить «чекбокс
          выключен» (`name` не приходит в `FormData`) от «блок не
          рендерился». См. `actions.ts::SETTINGS_BOOLEAN_FIELDS`.
        */}
        <input
          type="hidden"
          name="autoIssueMaterialsOnCutRelease__present"
          value="1"
        />
        <input
          type="hidden"
          name="allowNegativeMaterialStock__present"
          value="1"
        />
        <div className="admin-field">
          <label className="admin-field--inline" htmlFor="company-autoIssueMaterialsOnCutRelease">
            <input
              id="company-autoIssueMaterialsOnCutRelease"
              type="checkbox"
              name="autoIssueMaterialsOnCutRelease"
              defaultChecked={settings.autoIssueMaterialsOnCutRelease}
            />
            <span>Автосписание материалов при выдаче кроя</span>
          </label>
          <span className="admin-field__hint">
            Если включено, при выдаче кроя сотруднику система автоматически
            создаёт проведённый расход материалов по паспорту.
          </span>
          <span className="admin-field__hint">
            Использует плановую потребность заказа и распределяет расход
            пропорционально количеству паспорта.
          </span>
        </div>
        <div className="admin-field">
          <label className="admin-field--inline" htmlFor="company-allowNegativeMaterialStock">
            <input
              id="company-allowNegativeMaterialStock"
              type="checkbox"
              name="allowNegativeMaterialStock"
              defaultChecked={settings.allowNegativeMaterialStock}
            />
            <span>Разрешить отрицательные остатки материалов</span>
          </label>
          <span className="admin-field__hint">
            Если включено, расход материалов может увести складской остаток
            в минус.
          </span>
          <span className="admin-field__hint">
            Если выключить, проведение расхода материалов будет заблокировано
            при недостатке остатка. При включённом автосписании выдача кроя
            тоже может быть заблокирована.
          </span>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Банковские реквизиты" />
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="company-bankName">Название банка</label>
            <input
              id="company-bankName"
              name="bankName"
              type="text"
              defaultValue={settings.bankName ?? ''}
              maxLength={COMPANY_SETTINGS_BANK_NAME_MAX_LENGTH}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-bik">БИК</label>
            <input
              id="company-bik"
              name="bik"
              type="text"
              inputMode="numeric"
              defaultValue={settings.bik ?? ''}
              maxLength={9}
              placeholder="9 цифр"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-settlementAccount">Расчётный счёт</label>
            <input
              id="company-settlementAccount"
              name="settlementAccount"
              type="text"
              inputMode="numeric"
              defaultValue={settings.settlementAccount ?? ''}
              maxLength={20}
              placeholder="20 цифр"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="company-correspondentAccount">
              Корреспондентский счёт
            </label>
            <input
              id="company-correspondentAccount"
              name="correspondentAccount"
              type="text"
              inputMode="numeric"
              defaultValue={settings.correspondentAccount ?? ''}
              maxLength={20}
              placeholder="20 цифр"
            />
          </div>
        </div>
      </AdminCard>

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
        <SubmitButton />
      </div>
    </form>
  );
}
