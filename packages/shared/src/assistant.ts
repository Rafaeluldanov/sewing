/**
 * Контракты модуля «Ассистент» — окно диалога с ИИ внутри админки.
 *
 * Что это. Пользователь админки спрашивает про систему («сколько заказов
 * в производстве», «где паспорт P-…», «что значит статус “Расчёт готов”»),
 * модель отвечает, вызывая READ-ONLY инструменты поверх существующих
 * сервисов. Ассистент ничего не меняет в БД: весь набор инструментов —
 * только чтение (см. `apps/api/src/modules/assistant/tools/*`).
 *
 * Границы, зашитые в контракт (а не в промпт):
 *   - инструменты исполняются в контексте ТЕКУЩЕГО запроса, значит под
 *     тем же тенантом и с теми же ролями, что и обычный вызов API.
 *     Ассистент физически не видит того, чего не видит пользователь;
 *   - группы данных (`AssistantDataScope`) отключаются в настройках
 *     компании и режут доступный набор инструментов ДО обращения к
 *     модели. Деньги и зарплата по умолчанию выключены;
 *   - ключ Anthropic наружу не отдаётся никогда — в DTO только флаг
 *     `hasOwnKey` (как `hasPassword` в `integration.ts`).
 *
 * Настройки живут в singleton-строке `IntegrationSettings` (одна на
 * тенант) рядом с настройками upgifts — отдельной таблицы фича не
 * заводит. См. `integration.ts` и `prisma/schema.prisma`.
 *
 * Связанные файлы:
 *   - `prisma/schema.prisma::IntegrationSettings` / `AssistantThread` /
 *     `AssistantMessage`
 *   - `apps/api/src/modules/assistant/*`
 *   - `apps/web/lib/assistant-api.ts`
 *   - `apps/web/components/assistant/assistant-drawer.tsx`
 *   - `docs/api.md §«Assistant»`
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Модели
// ---------------------------------------------------------------------------

/**
 * Модели, доступные в селекте настроек. Список сознательно короткий:
 * выбор из двадцати позиций — это не настройка, а лотерея.
 *
 * ВАЖНО: строки id — точные идентификаторы Anthropic API без даты-суффикса.
 * Прайс на токены живёт на бэкенде (`assistant/pricing.ts`), потому что
 * пересчёт стоимости — серверная ответственность.
 */
export const ASSISTANT_MODELS = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    hint: 'Точнее на сложных вопросах. ≈ $0,03 за вопрос.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    hint: 'Втрое дешевле, для типовых вопросов хватает.',
  },
] as const;

export type AssistantModelId = (typeof ASSISTANT_MODELS)[number]['id'];

export const ASSISTANT_MODEL_IDS = ASSISTANT_MODELS.map((m) => m.id) as [
  AssistantModelId,
  ...AssistantModelId[],
];

export const DEFAULT_ASSISTANT_MODEL: AssistantModelId = 'claude-opus-5';

/** Читаемая подпись модели (для UI и для ошибок). */
export function assistantModelLabel(id: string): string {
  return ASSISTANT_MODELS.find((m) => m.id === id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Источник ключа
// ---------------------------------------------------------------------------

/**
 * `PLATFORM` — ключ платформы из env `ANTHROPIC_API_KEY` (платит владелец
 * установки), `OWN` — ключ компании из `IntegrationSettings.assistantApiKeyEnc`
 * (шифруется тем же `secret-box.ts`, что и пароль upgifts).
 */
export const ASSISTANT_KEY_SOURCES = ['PLATFORM', 'OWN'] as const;
export type AssistantKeySource = (typeof ASSISTANT_KEY_SOURCES)[number];

// ---------------------------------------------------------------------------
// Группы данных
// ---------------------------------------------------------------------------

/**
 * Группа данных = набор инструментов. Выключенная группа не доезжает до
 * модели вообще: её инструменты не попадают в запрос, поэтому модель не
 * может их «уговорить» позвать.
 *
 * Деньги и зарплата по умолчанию ВЫКЛЮЧЕНЫ — включение это осознанное
 * решение владельца, а не побочный эффект обновления.
 */
export const ASSISTANT_DATA_SCOPES = [
  'PRODUCTION',
  'SUPPLY',
  'MONEY',
  'PAYROLL',
] as const;
export type AssistantDataScope = (typeof ASSISTANT_DATA_SCOPES)[number];

export const ASSISTANT_SCOPE_LABELS: Record<
  AssistantDataScope,
  { title: string; hint: string }
> = {
  PRODUCTION: {
    title: 'Производство и заказы',
    hint: 'Заказы, паспорта, маршруты, смены, цех.',
  },
  SUPPLY: {
    title: 'Снабжение и склад',
    hint: 'Потребность цеха, закупки, остатки материалов.',
  },
  MONEY: {
    title: 'Деньги и себестоимость',
    hint: 'Сметы, плановая себестоимость, маржа.',
  },
  PAYROLL: {
    title: 'Зарплата',
    hint: 'Выработка в рублях, начисления, выплаты.',
  },
};

// ---------------------------------------------------------------------------
// Лимиты
// ---------------------------------------------------------------------------

export const ASSISTANT_DAILY_LIMIT_MIN = 0;
export const ASSISTANT_DAILY_LIMIT_MAX = 1000;
export const ASSISTANT_DEFAULT_DAILY_LIMIT = 30;

/** Потолок расхода в месяц, в центах. 10000 = $100. */
export const ASSISTANT_MONTHLY_BUDGET_MIN_CENTS = 0;
export const ASSISTANT_MONTHLY_BUDGET_MAX_CENTS = 10_000_000; // $100 000
export const ASSISTANT_DEFAULT_MONTHLY_BUDGET_CENTS = 10_000; // $100

export const ASSISTANT_QUESTION_MAX_LENGTH = 2000;
export const ASSISTANT_API_KEY_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------
// Запрос
// ---------------------------------------------------------------------------

export const AssistantAskSchema = z.object({
  /** Вопрос пользователя. Пустая строка отсекается здесь, а не в UI. */
  question: z
    .string()
    .trim()
    .min(1, 'Вопрос не может быть пустым')
    .max(
      ASSISTANT_QUESTION_MAX_LENGTH,
      `Вопрос не длиннее ${ASSISTANT_QUESTION_MAX_LENGTH} символов`,
    ),
  /**
   * Продолжение существующего диалога. `undefined` ⇒ создать новый тред.
   * Чужой тред вернёт 404 — тред принадлежит сотруднику.
   */
  threadId: z.string().min(1).max(64).optional(),
  /**
   * Раздел админки, из которого задан вопрос (`/admin/orders`). Уходит в
   * контекст как подсказка «о чём человек сейчас думает» и в подсказки
   * пустого состояния. Не влияет на права.
   */
  route: z.string().max(200).optional(),
});

export type AssistantAskDto = z.infer<typeof AssistantAskSchema>;

// ---------------------------------------------------------------------------
// Ответ: вызовы инструментов и источники
// ---------------------------------------------------------------------------

/**
 * Строка «куда полез ассистент» — показывается в шторке под вопросом.
 * Прозрачность здесь не украшение: пользователь должен видеть, откуда
 * взялось число, иначе доверять ответу нельзя.
 */
export interface AssistantToolCallDto {
  id: string;
  /** Машинное имя (`orders.search`) — показываем моноширинным. */
  name: string;
  /** Человеческая подпись («Смотрю заказы»). */
  label: string;
  /** Длительность вызова, мс. */
  ms: number;
  ok: boolean;
  /** Причина отказа — например «нет доступа» (403 от гварда). */
  error?: string | null;
}

/**
 * Ссылка на реальную сущность, по которой можно проверить ответ глазами.
 * `href` — маршрут админки, не внешний URL.
 */
export interface AssistantSourceDto {
  label: string;
  sublabel?: string | null;
  href: string;
}

// ---------------------------------------------------------------------------
// Ответ: сообщения и тред
// ---------------------------------------------------------------------------

export type AssistantMessageRole = 'USER' | 'ASSISTANT';

export interface AssistantMessageDto {
  id: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls: AssistantToolCallDto[];
  sources: AssistantSourceDto[];
  /** Момент ответа (ISO). В UI показываем в московском времени. */
  createdAt: string;
  /** Машинный код ошибки, если ответ не получился (`ASSISTANT_LIMIT_REACHED`…). */
  errorCode?: string | null;
}

export interface AssistantThreadDto {
  id: string;
  title: string | null;
  createdAt: string;
  messages: AssistantMessageDto[];
}

// ---------------------------------------------------------------------------
// SSE-протокол
// ---------------------------------------------------------------------------

/**
 * События потока `POST /api/assistant/ask` (`text/event-stream`).
 *
 * Почему поток, а не один JSON: агентный проход с инструментами живёт
 * 5–30 секунд, и молчащее окно всё это время читается как «сломалось».
 * nginx на `/api/` уже отдаёт с `proxy_buffering off`, так что события
 * доходят по мере генерации (см. `nginx/conf.d/*.conf`).
 */
export type AssistantStreamEvent =
  /** Первое событие: id треда (нужен для последующих вопросов). */
  | { type: 'thread'; threadId: string; messageId: string }
  /** Ассистент начал вызов инструмента. */
  | { type: 'tool'; id: string; name: string; label: string }
  /** Инструмент отработал. */
  | { type: 'tool_done'; id: string; ms: number; ok: boolean; error?: string }
  /** Кусок текста ответа. */
  | { type: 'text'; delta: string }
  /** Источники — приходят один раз, перед `done`. */
  | { type: 'sources'; sources: AssistantSourceDto[] }
  /** Успешное завершение. */
  | { type: 'done'; messageId: string; usage: AssistantUsageDto }
  /** Ошибка. Поток после этого закрывается. */
  | { type: 'error'; code: string; message: string };

export interface AssistantUsageDto {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Стоимость обращения в микродолларах ($0,03 = 30000). */
  costUsdMicros: number;
}

// ---------------------------------------------------------------------------
// Конфиг для шторки
// ---------------------------------------------------------------------------

/**
 * `GET /api/assistant/config` — всё, что нужно шторке, чтобы решить,
 * показываться ли и что писать в подвале. Ключей и секретов здесь нет.
 */
export interface AssistantConfigDto {
  /** Включён в настройках И на сервере есть рабочий ключ. */
  available: boolean;
  /** Почему недоступен (для админа — подсказка, куда идти). */
  unavailableReason: string | null;
  model: string;
  modelLabel: string;
  /** Осталось вопросов сегодня у текущего сотрудника (null ⇒ без лимита). */
  questionsLeftToday: number | null;
  /** Включённые группы данных — шторка пишет их в подсказках. */
  scopes: AssistantDataScope[];
}

// ---------------------------------------------------------------------------
// Машинные коды ошибок
// ---------------------------------------------------------------------------

export const ASSISTANT_ERROR_CODES = {
  DISABLED: 'ASSISTANT_DISABLED',
  NO_KEY: 'ASSISTANT_NO_KEY',
  DAILY_LIMIT: 'ASSISTANT_DAILY_LIMIT_REACHED',
  BUDGET: 'ASSISTANT_BUDGET_REACHED',
  THREAD_NOT_FOUND: 'ASSISTANT_THREAD_NOT_FOUND',
  UPSTREAM: 'ASSISTANT_UPSTREAM_ERROR',
  REFUSAL: 'ASSISTANT_REFUSAL',
} as const;
