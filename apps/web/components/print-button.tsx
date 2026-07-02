'use client';

import { useTransition, useState } from 'react';
import type { PrintJobSource } from '@sewing/shared/printers';
import { Icon } from './icon';
import { newIdempotencyKey } from '@/lib/idempotency';
import { sendPrintJob } from './print-button-actions';

interface Props {
  sourceType: PrintJobSource;
  sourceId?: string;
  /** Резервный URL — если у пользователя нет подходящего принтера, открываем в новой вкладке. */
  fallbackHref?: string;
  className?: string;
  label?: string;
  iconName?: 'scan' | 'output' | 'arrow-right';
}

/**
 * Универсальная кнопка «Печать» (см. `docs/screens.md §18`).
 *
 * Поведение:
 *   - Сначала пытается создать `PrintJob` через `POST /api/print-jobs`
 *     — backend сам выберет принтер по активной смене и `equipmentId`.
 *   - Если backend ответил «принтер не настроен / нет активной смены»
 *     и есть `fallbackHref` — открываем старую печатную HTML-форму в
 *     новой вкладке (это сохраняет работоспособность UI на тех
 *     рабочих местах, где агент ещё не настроен).
 *   - В остальных случаях показываем текст ошибки рядом с кнопкой.
 */
export function PrintButton({
  sourceType,
  sourceId,
  fallbackHref,
  className = 'btn btn-primary',
  label = 'Печать',
  iconName = 'scan',
}: Props) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  function handleClick() {
    setFeedback(null);
    // Свежий ключ на каждое нажатие: осознанная повторная печать — это
    // новый ключ и новый job, а вот случайная двойная доставка ЭТОГО
    // запроса (ретрай транспорта) свернётся на бэке в один job.
    const idempotencyKey = newIdempotencyKey();
    startTransition(async () => {
      const res = await sendPrintJob({ sourceType, sourceId, idempotencyKey });
      if (res.ok) {
        setFeedback({
          kind: 'ok',
          text: 'Отправлено на принтер рабочего места.',
        });
        return;
      }
      const noPrinter =
        res.code === 'PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT' ||
        res.code === 'SHIFT_SESSION_REQUIRED' ||
        res.code === 'PRINTER_NOT_FOUND';
      if (noPrinter && fallbackHref) {
        if (typeof window !== 'undefined') {
          window.open(fallbackHref, '_blank', 'noopener');
        }
        setFeedback({
          kind: 'ok',
          text: 'Принтер не настроен — открыта печатная форма в браузере.',
        });
        return;
      }
      setFeedback({
        kind: 'err',
        text: res.error ?? 'Не удалось отправить на печать.',
      });
    });
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={handleClick}
      >
        <Icon name={iconName} size={16} />
        {pending ? 'Отправляем…' : label}
      </button>
      {feedback && (
        <span
          className="meta-line"
          style={{
            color:
              feedback.kind === 'ok'
                ? 'var(--color-ok-fg)'
                : 'var(--color-danger-fg)',
          }}
        >
          {feedback.text}
        </span>
      )}
    </span>
  );
}
