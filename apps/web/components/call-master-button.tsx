'use client';

/**
 * Кнопка «Мастер» на рабочих экранах (`/work`, `/qc`, `/wto`,
 * `/packing`).
 *
 * Контракт UX (см. `docs/screens.md §«Кнопка мастер»`,
 * `docs/flows.md §«Вызов мастера»`):
 *   - Один тап — POST `/api/master-calls` через server action
 *     (`callMasterAction`). Идемпотентность гарантируется backend'ом
 *     (`MasterCallsService.create`): второй тап того же сотрудника
 *     не плодит дубль и возвращает существующий открытый вызов.
 *   - После успешного вызова кнопка показывает «Мастер вызван» и
 *     остаётся disabled до закрытия вызова мастером (UI о закрытии
 *     не знает — после revalidate/перезагрузки страницы статус
 *     сбросится).
 *   - Не блокирует основной flow: при ошибке backend'а просто
 *     показываем краткий toast/inline-message, рабочий продолжает
 *     сканировать паспорта.
 *
 * Позиционирование:
 *   - На мобильных терминалах оборачиваем `position: fixed; bottom`,
 *     чтобы кнопка была доступна одной рукой и не уезжала под
 *     scroll'ом форм. Класс `call-master-fab` добавляется родителем —
 *     сам компонент стилей не диктует, чтобы layout каждого
 *     терминала мог при желании поставить её как inline-кнопку (для
 *     desktop-debug страниц).
 */

import { useState, useTransition } from 'react';
import { callMasterAction } from '@/app/master/actions';

interface Props {
  /**
   * Если true — кнопка стилизуется как floating action button
   * (большая круглая внизу справа). Это дефолт для рабочих
   * терминалов (`/work`, `/qc`, `/wto`, `/packing`).
   */
  floating?: boolean;
  /** Доп. CSS-класс на корневой кнопке. */
  className?: string;
}

export function CallMasterButton({ floating = true, className }: Props) {
  const [pending, startTransition] = useTransition();
  const [called, setCalled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const res = await callMasterAction();
      if (res.ok) {
        setCalled(true);
      } else {
        setError(res.error);
      }
    });
  };

  const baseClass = floating ? 'call-master-btn call-master-btn--fab' : 'call-master-btn';
  const cls = [baseClass, className].filter(Boolean).join(' ');

  return (
    <div className="call-master-wrap" data-testid="call-master-wrap">
      <button
        type="button"
        className={cls}
        onClick={handleClick}
        disabled={pending || called}
        data-testid="call-master-button"
        data-state={called ? 'called' : 'idle'}
        aria-pressed={called}
        aria-label={called ? 'Мастер уже вызван' : 'Вызвать мастера'}
      >
        <span className="call-master-btn__icon" aria-hidden="true">
          {called ? '✓' : '!'}
        </span>
        <span className="call-master-btn__label">
          {pending ? 'Вызов…' : called ? 'Мастер вызван' : 'Мастер'}
        </span>
      </button>
      {error ? (
        <p className="call-master-btn__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
