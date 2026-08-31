'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import {
  shiftMaxDurationLabel,
  SHIFT_AUTO_CLOSE_MODES,
  SHIFT_AUTO_CLOSE_MODE_LABELS,
  SHIFT_MAX_DURATION_PRESETS,
  type CompanySettingsDto,
} from '@sewing/shared/company-settings';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import { updateShiftAutoCloseAction } from './actions';
import {
  initialUpdateShiftAutoCloseState,
  type UpdateShiftAutoCloseState,
} from './form-state';

/**
 * Секция «Завершение смены» на `/admin/company-settings?tab=security`.
 *
 * Смена и сессия — разные вещи: человек может выйти из системы, а смена
 * продолжит идти. Её не закрывают почти никогда, и цифры времени
 * становятся бессмысленными — на 31.08.2026 из 755 закрытых смен 429
 * длиннее 10 часов, 194 дольше суток, рекорд 68 суток.
 *
 * Два порога вместо одного: время суток закрывает дневные смены, а
 * предельная длительность — те, что начались уже после этого времени
 * (у них ближайший порог почти через сутки).
 *
 * Отдельный выбор «чем считать конец» — то, ради чего всё делается.
 * Закрыть смену порогом легко, но если человек ушёл в 17:00, а порог в
 * 22:00, часы останутся такими же неправдой. Поэтому по умолчанию конец
 * берётся по последней отметке сотрудника.
 */

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Save size={16} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

export function ShiftAutoCloseSection({
  settings,
}: {
  settings: CompanySettingsDto;
}) {
  const [state, formAction] = useFormState<UpdateShiftAutoCloseState, FormData>(
    updateShiftAutoCloseAction,
    initialUpdateShiftAutoCloseState,
  );

  return (
    <AdminCard>
      <AdminSectionHeader
        title="Завершение смены"
        hint="что делать со сменами, которые сотрудник не закрыл"
      />
      <div style={{ height: 8 }} />

      <form action={formAction} className="off-route">
        <div className="off-route__control">
          <label className="off-route__label" htmlFor="shiftAutoCloseTime">
            Закрывать смены в
          </label>
          <input
            type="time"
            id="shiftAutoCloseTime"
            name="shiftAutoCloseTime"
            defaultValue={settings.shiftAutoCloseTime ?? ''}
            className="off-route__select"
          />
          <span className="off-route__label">по Москве, пусто — не закрывать</span>
        </div>

        <div className="off-route__control">
          <label className="off-route__label" htmlFor="shiftMaxDurationHours">
            И не дольше
          </label>
          <select
            id="shiftMaxDurationHours"
            name="shiftMaxDurationHours"
            defaultValue={String(settings.shiftMaxDurationHours)}
            className="off-route__select"
          >
            {SHIFT_MAX_DURATION_PRESETS.map((hours) => (
              <option key={hours} value={hours}>
                {shiftMaxDurationLabel(hours)}
              </option>
            ))}
          </select>
        </div>

        <div className="off-route__control">
          <label className="off-route__label" htmlFor="shiftAutoCloseMode">
            Концом смены считать
          </label>
          <select
            id="shiftAutoCloseMode"
            name="shiftAutoCloseMode"
            defaultValue={settings.shiftAutoCloseMode}
            className="off-route__select"
          >
            {SHIFT_AUTO_CLOSE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SHIFT_AUTO_CLOSE_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
          <SaveButton />
        </div>

        <p className="off-route__desc">
          <b>По последней отметке</b> — смена заканчивается там, где
          сотрудник в последний раз что-то сделал: закрыл операцию, взял
          крой, переключил операцию. Именно это чинит аналитику: в часы
          перестают попадать вечер и ночь, когда в цехе никого не было.
          Если отметок не было вовсе, смена засчитывается нулевой.{' '}
          <b>По времени завершения</b> — часы дорисовываются до порога:
          предсказуемо, но щедро.
        </p>
        <p className="off-route__desc">
          Смены закрываются не по расписанию, а при заходе на экраны, где
          эти цифры и нужны: «Сотрудники» в кабинете мастера, тайм-трекер
          и старт новой смены. На практике вчерашние смены закрываются
          первым же утренним заходом. Сдельная выработка не затрагивается
          — она считается по закрытым операциям, а не по часам.
        </p>
        <p className="off-route__desc">
          Ночным сменам ставьте время после их окончания: смена, идущая
          через порог, будет закрыта, и сотруднику придётся начать новую.
        </p>

        {state.error && (
          <p className="form-error" role="alert">
            <XCircle size={16} aria-hidden /> {state.error}
            {state.errorRequestId ? ` (${state.errorRequestId})` : ''}
          </p>
        )}
        {state.ok && state.successMessage && (
          <p className="form-success" role="status">
            <CheckCircle size={16} aria-hidden /> {state.successMessage}
          </p>
        )}
      </form>
    </AdminCard>
  );
}
