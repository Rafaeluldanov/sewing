'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { MessageSquare, Plus, Send, X } from 'lucide-react';
import type {
  AssistantConfigDto,
  AssistantSourceDto,
  AssistantToolCallDto,
} from '@sewing/shared/assistant';
import { askAssistant, fetchAssistantConfig } from '@/lib/assistant-api';

/**
 * Шторка ассистента — окно «Спросить» в админке.
 *
 * Держится в правом нижнем углу свёрнутой пилюлей и разворачивается в
 * панель поверх контента. Страница под ней не перестраивается: фича
 * добавляет ровно один элемент в интерфейс и ничего не двигает.
 *
 * Ответ приходит потоком, поэтому в ленте видно, что происходит: строки
 * вызовов инструментов появляются по мере работы, текст печатается.
 * Прозрачность здесь не украшение — пользователь должен видеть, откуда
 * взялось число, иначе доверять ответу нельзя.
 *
 * Монтируется в `app/admin/layout.tsx` под флагом `FEATURE_AI_ASSISTANT`.
 */

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: AssistantToolCallDto[];
  sources: AssistantSourceDto[];
  error?: string;
}

const SUGGESTIONS: { kind: string; text: string }[] = [
  { kind: 'Данные', text: 'Сколько заказов в производстве и какие горят по сроку?' },
  { kind: 'Данные', text: 'Где сейчас узкое место в цехе?' },
  { kind: 'Справка', text: 'Что значит статус «Расчёт готов»?' },
];

export function AssistantDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<AssistantConfigDto | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Конфиг тянем один раз при первом открытии: до этого фича не должна
  // стоить ни одного запроса.
  useEffect(() => {
    if (!open || config) return;
    const ctrl = new AbortController();
    fetchAssistantConfig(ctrl.signal)
      .then(setConfig)
      .catch(() => {
        setConfig({
          available: false,
          unavailableReason: 'Не удалось получить настройки ассистента.',
          model: '',
          modelLabel: '',
          questionsLeftToday: null,
          scopes: [],
        });
      });
    return () => ctrl.abort();
  }, [open, config]);

  // Автопрокрутка к низу ленты при любом изменении.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;

      setInput('');
      setBusy(true);
      const userId = `u-${Date.now()}`;
      const botId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', text, tools: [], sources: [] },
        { id: botId, role: 'assistant', text: '', tools: [], sources: [] },
      ]);

      const patchBot = (patch: (m: UiMessage) => UiMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === botId ? patch(m) : m)));

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await askAssistant(
          { question: text, threadId, route: pathname ?? undefined },
          (event) => {
            switch (event.type) {
              case 'thread':
                setThreadId(event.threadId);
                break;
              case 'tool':
                patchBot((m) => ({
                  ...m,
                  tools: [
                    ...m.tools,
                    {
                      id: event.id,
                      name: event.name,
                      label: event.label,
                      ms: 0,
                      ok: true,
                    },
                  ],
                }));
                break;
              case 'tool_done':
                patchBot((m) => ({
                  ...m,
                  tools: m.tools.map((t) =>
                    t.id === event.id
                      ? { ...t, ms: event.ms, ok: event.ok, error: event.error }
                      : t,
                  ),
                }));
                break;
              case 'text':
                patchBot((m) => ({ ...m, text: m.text + event.delta }));
                break;
              case 'sources':
                patchBot((m) => ({ ...m, sources: event.sources }));
                break;
              case 'error':
                patchBot((m) => ({ ...m, error: event.message }));
                break;
              case 'done':
                break;
            }
          },
          ctrl.signal,
        );
      } catch {
        patchBot((m) => ({
          ...m,
          error: 'Связь с ассистентом прервалась. Попробуйте ещё раз.',
        }));
      } finally {
        setBusy(false);
        abortRef.current = null;
        // Остаток дневного лимита изменился — перечитаем при следующем
        // открытии, а не дёргаем запрос сейчас.
        setConfig((c) =>
          c && c.questionsLeftToday !== null
            ? { ...c, questionsLeftToday: Math.max(0, c.questionsLeftToday - 1) }
            : c,
        );
      }
    },
    [busy, pathname, threadId],
  );

  if (!open) {
    return (
      <button
        type="button"
        className="assistant-fab"
        onClick={() => setOpen(true)}
        aria-label="Спросить ассистента"
      >
        <MessageSquare size={18} strokeWidth={2.1} aria-hidden />
        Спросить
      </button>
    );
  }

  return (
    <aside className="assistant" aria-label="Ассистент">
      <div className="assistant__head">
        <h2 className="assistant__title">Ассистент</h2>
        <span className="assistant__beta">бета</span>
        <span className="assistant__spacer" />
        <button
          type="button"
          className="assistant__iconbtn"
          title="Новый диалог"
          aria-label="Новый диалог"
          onClick={() => {
            setMessages([]);
            setThreadId(undefined);
          }}
        >
          <Plus size={17} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="assistant__iconbtn"
          title="Закрыть"
          aria-label="Закрыть"
          onClick={() => setOpen(false)}
        >
          <X size={17} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="assistant__body" ref={bodyRef}>
        {config && !config.available && (
          <div className="assistant__note assistant__note--warn">
            {config.unavailableReason}
          </div>
        )}

        {messages.length === 0 && (
          <div className="assistant__empty">
            <h3>Спросите про производство</h3>
            <p>
              Отвечаю по вашим данным и по устройству системы. Ничего не меняю.
            </p>
            <div className="assistant__hints">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text}
                  type="button"
                  className="assistant__hint"
                  onClick={() => void send(s.text)}
                  disabled={busy || (config ? !config.available : false)}
                >
                  <b>{s.kind}</b>
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="assistant__msg assistant__msg--user">
              <div className="assistant__bubble">{m.text}</div>
            </div>
          ) : (
            <div key={m.id} className="assistant__msg">
              {m.tools.map((t) => (
                <div
                  key={t.id}
                  className={`assistant__tool${t.ms === 0 ? ' assistant__tool--live' : ''}`}
                >
                  {t.label} <code>{t.name}</code>
                  {t.ms > 0 && (
                    <span className="assistant__tool-time">
                      {(t.ms / 1000).toFixed(1)} с
                    </span>
                  )}
                  {t.error && (
                    <span className="assistant__tool-time">— {t.error}</span>
                  )}
                </div>
              ))}

              {m.text && <div className="assistant__text">{m.text}</div>}

              {m.sources.length > 0 && (
                <div className="assistant__sources">
                  <div className="assistant__sources-cap">Источники</div>
                  {m.sources.map((s) => (
                    <a key={s.href} className="assistant__source" href={s.href}>
                      <span className="assistant__source-label">{s.label}</span>
                      {s.sublabel && (
                        <span className="assistant__source-sub">{s.sublabel}</span>
                      )}
                      <span className="assistant__source-go" aria-hidden>
                        →
                      </span>
                    </a>
                  ))}
                </div>
              )}

              {m.error && (
                <div className="assistant__note assistant__note--warn">
                  {m.error}
                </div>
              )}

              {busy && !m.text && !m.error && m.tools.length === 0 && (
                <div className="assistant__text assistant__text--muted">
                  Думаю…
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className="assistant__foot">
        <form
          className="assistant__composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input
            className="assistant__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Спросите про заказы, паспорта, цех…"
            disabled={busy || (config ? !config.available : false)}
            aria-label="Вопрос ассистенту"
          />
          <button
            type="submit"
            className="assistant__send"
            disabled={busy || !input.trim() || (config ? !config.available : false)}
            aria-label="Отправить"
          >
            <Send size={16} strokeWidth={2.2} aria-hidden />
          </button>
        </form>
        <p className="assistant__footnote">
          Ассистент только читает данные и видит ровно то же, что и вы.
          {config?.questionsLeftToday !== null &&
            config?.questionsLeftToday !== undefined &&
            ` Осталось вопросов сегодня: ${config.questionsLeftToday}.`}
        </p>
      </div>
    </aside>
  );
}
