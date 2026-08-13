/**
 * Клиент модуля «Ассистент» (`/api/assistant/*`).
 *
 * Особенность: ответ приходит ПОТОКОМ (SSE), поэтому обычный `apiFetch`
 * тут не подходит — он ждёт готовый JSON. `EventSource` тоже не годится:
 * он умеет только GET, а вопрос уезжает телом POST. Поэтому читаем
 * `fetch(...).body` как поток и разбираем кадры `data: …` сами.
 *
 * Вызывается ИЗ БРАУЗЕРА (шторка — client component), поэтому базовый
 * URL берём из `getApiBaseUrl()` и шлём куку сессии явным
 * `credentials: 'include'`.
 *
 * См. `apps/api/src/modules/assistant/*`, `packages/shared/src/assistant.ts`.
 */

import type {
  AssistantAskDto,
  AssistantConfigDto,
  AssistantStreamEvent,
} from '@sewing/shared/assistant';
import { getApiBaseUrl } from './api-base';

/** Конфиг шторки: доступен ли ассистент, модель, остаток лимита. */
export async function fetchAssistantConfig(
  signal?: AbortSignal,
): Promise<AssistantConfigDto> {
  const res = await fetch(`${getApiBaseUrl()}/assistant/config`, {
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`assistant/config: ${res.status}`);
  return (await res.json()) as AssistantConfigDto;
}

/**
 * Задать вопрос. События отдаются в `onEvent` по мере генерации.
 * Промис резолвится, когда поток закрыт.
 *
 * Ожидаемые отказы (лимит, выключено, ошибка модели) приезжают СОБЫТИЕМ
 * `error`, а не исключением — шторка показывает их в ленте. Исключение
 * бросается только на сбое самого HTTP.
 */
export async function askAssistant(
  body: AssistantAskDto,
  onEvent: (event: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getApiBaseUrl()}/assistant/ask`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`assistant/ask: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Кадры SSE разделены пустой строкой. Хвост без разделителя
    // оставляем в буфере до следующего чанка — иначе рвём JSON пополам.
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (line) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as AssistantStreamEvent);
        } catch {
          // Битый кадр молча пропускаем: один потерянный дельта-кусок
          // не повод ронять весь ответ.
        }
      }
      sep = buffer.indexOf('\n\n');
    }
  }
}
