'use client';

/**
 * Кнопка-чип «Мой день» в кабинете сотрудника + панель с разбивкой.
 *
 * UX (см. обсуждение в `MEMORY.md` / переписке):
 *   - чип сидит в `.employee-toolbar` (правый столбик) рядом с
 *     «Мастер» и «Мой QR» на всех терминалах сотрудников;
 *   - визуально — pill с одной короткой строкой («36шт · 720₽» для
 *     сделки, «1 500₽» для оклада, «12шт · 240₽ +окл» для MIXED);
 *   - по клику открывается модальная панель `DailyEarningsPanel`
 *     с разбивкой по операциям, временем смены и PENDING-пометкой;
 *   - в панели — кнопка «История 30 дней», которая открывает
 *     `EarningsHistoryModal`.
 *
 * Загрузка:
 *   - при первом mount грузим `/api/me/daily` лениво (один запрос
 *     при открытии страницы) — данные нужны сразу для отрисовки цифр
 *     в чипе;
 *   - при открытии панели перезагружаем — за время сидения на
 *     странице мог уже выпасть новый OPERATION_FINISHED;
 *   - polling сознательно не делаем: основной триггер обновления —
 *     `router.refresh()` после действия (Завершить операцию и т.п.),
 *     которое уже зашито в существующих формах.
 *
 * Чип показывается всегда, когда задан тип компенсации (даже при
 * нулевой выработке: «0шт · 0₽» / «0₽»). Ничего не рендерим только если
 * `compensationType === null` (расчёта у роли нет вовсе).
 */

import { useCallback, useEffect, useState } from 'react';
import type { MeDailyDto } from '@sewing/shared/me-daily';
import { getMyDailyAction } from '@/app/me/actions';
import { DailyEarningsPanel } from './daily-earnings-panel';

export interface DailyEarningsChipProps {
  /** Дополнительный CSS-класс на корневой кнопке. */
  className?: string;
}

export function DailyEarningsChip({ className }: DailyEarningsChipProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<MeDailyDto | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyDailyAction();
    if (res.ok) setData(res.data);
    else setData(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onOpen = useCallback(() => {
    setOpen(true);
    void load(); // обновляем при каждом открытии — см. JSDoc
  }, [load]);

  const onClose = useCallback(() => setOpen(false), []);

  // Чип скрыт, пока не понятно, есть ли вообще что показывать.
  // Skeleton на первой загрузке выглядел бы шумно в углу терминала.
  if (loading && !data) return null;
  // Показываем чип во всех кабинетах, где он размещён (кроме мастера —
  // там его просто не рендерят), даже при нулевой выработке: для сделки
  // это «0шт · 0₽», для оклада «0₽». Скрываем только если тип
  // компенсации вообще не задан (показывать нечего и расчёта нет).
  if (!data || data.compensationType === null) return null;

  const chipLabel = formatChip(data);
  const chipClass = ['my-day-chip', className].filter(Boolean).join(' ');

  return (
    <>
      <button
        type="button"
        className={chipClass}
        onClick={onOpen}
        data-testid="my-day-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Мой день: ${chipLabel}`}
      >
        <span className="my-day-chip__icon" aria-hidden="true">
          ₽
        </span>
        <span className="my-day-chip__label">{chipLabel}</span>
      </button>

      {open ? (
        <DailyEarningsPanel data={data} onClose={onClose} onReload={load} />
      ) : null}
    </>
  );
}

/**
 * Компактная строка для чипа. Несколько форм в зависимости от
 * `compensationType` и наличия активности.
 */
function formatChip(data: MeDailyDto): string {
  const pw = data.piecework;
  const sal = data.salary;

  if (data.compensationType === 'PIECEWORK') {
    if (!pw || pw.totalQty === 0) return `0шт · 0₽`;
    return `${pw.totalQty}шт · ${formatMoney(pw.totalAmount)}`;
  }

  if (data.compensationType === 'SALARY') {
    if (!sal) return '0₽';
    return formatMoney(sal.amount);
  }

  // MIXED — показываем штуки + сумму с пометкой «+окл», если оклад в плюс.
  const qty = pw?.totalQty ?? 0;
  const pwAmount = pw?.totalAmount ?? 0;
  const salAmount = sal?.amount ?? 0;
  if (salAmount > 0) {
    return `${qty}шт · ${formatMoney(pwAmount + salAmount)}`;
  }
  return `${qty}шт · ${formatMoney(pwAmount)}`;
}

function formatMoney(value: number): string {
  // Без копеек для чипа: тесно. Полная цифра — в панели.
  const rounded = Math.round(value);
  return `${rounded.toLocaleString('ru-RU')}₽`;
}
