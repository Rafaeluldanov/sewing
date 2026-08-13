import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ASSISTANT_ERROR_CODES,
  DEFAULT_ASSISTANT_MODEL,
  type AssistantAskDto,
  type AssistantConfigDto,
  type AssistantDataScope,
  type AssistantSourceDto,
  type AssistantStreamEvent,
  type AssistantToolCallDto,
  assistantModelLabel,
} from '@sewing/shared/assistant';
import { INTEGRATION_SETTINGS_SINGLETON_ID } from '@sewing/shared/integration';
import { moscowDayKey, moscowDayWindow } from '../../common/moscow-date.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { decryptSecret } from '../integrations/secret-box.js';
import { toolsForScopes, type AssistantTool } from './assistant-tools.js';
import { costUsdMicros, microsToCents, type TokenUsage } from './pricing.js';

/**
 * Сервис ассистента: собирает контекст, гоняет агентный цикл с
 * инструментами и пишет историю.
 *
 * Три вещи, ради которых он вообще существует отдельно от контроллера:
 *
 *   1. ЛИМИТЫ. Суточный на сотрудника и месячный потолок расхода на
 *      компанию проверяются ДО обращения к модели. Без них один
 *      любопытный пользователь за вечер открутит месячный бюджет.
 *   2. ГРУППЫ ДАННЫХ. Выключенная группа режется здесь — её инструменты
 *      не уезжают в запрос, поэтому промптом их не выпросить.
 *   3. КЭШ ПРЕФИКСА. Системный промпт и описания инструментов стабильны
 *      байт-в-байт (никаких дат и имён внутри), поэтому повторное чтение
 *      стоит ~10% от обычного. Всё переменное живёт в конце — в
 *      сообщении пользователя.
 *
 * Инструменты исполняются В КОНТЕКСТЕ ТЕКУЩЕГО ЗАПРОСА: `PrismaService`
 * это Proxy по `TenantContext` (AsyncLocalStorage), и обращение к БД вне
 * контекста запроса падает громко. Поэтому весь цикл живёт внутри
 * обработчика, а не уезжает в очередь или в фон.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  /** Потолок проходов агентного цикла — страховка от бесконечной болтовни. */
  private static readonly MAX_ITERATIONS = 6;
  /**
   * Потолок вывода на один проход. На Opus 5 размышление включено по
   * умолчанию и делит этот бюджет с текстом ответа — 8000 хватало бы
   * впритык и обрезало бы длинные ответы на полуслове.
   */
  private static readonly MAX_TOKENS = 16_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // Конфиг для шторки
  // ===========================================================================

  async getConfig(user: AuthPrincipal): Promise<AssistantConfigDto> {
    const settings = await this.loadSettings();
    const model = settings?.assistantModel ?? DEFAULT_ASSISTANT_MODEL;
    const scopes = scopesOf(settings);

    const reason = this.unavailableReason(settings);
    const limit = settings?.assistantDailyLimitPerUser ?? 0;
    const questionsLeftToday =
      limit > 0 ? Math.max(0, limit - (await this.askedToday(user.employeeId))) : null;

    return {
      available: reason === null,
      unavailableReason: reason,
      model,
      modelLabel: assistantModelLabel(model),
      questionsLeftToday,
      scopes,
    };
  }

  // ===========================================================================
  // Основной сценарий
  // ===========================================================================

  /**
   * Отвечает на вопрос, отдавая события через `emit`. Сам ничего не пишет
   * в HTTP — транспорт это забота контроллера.
   *
   * Не бросает на ожидаемых отказах (лимит, выключено, ошибка модели):
   * такие случаи уезжают событием `error`, чтобы шторка показала их в
   * ленте, а не «упала».
   */
  async ask(
    dto: AssistantAskDto,
    user: AuthPrincipal,
    emit: (event: AssistantStreamEvent) => void,
  ): Promise<void> {
    const settings = await this.loadSettings();

    const unavailable = this.unavailableReason(settings);
    if (unavailable || !settings) {
      emit({
        type: 'error',
        code: ASSISTANT_ERROR_CODES.DISABLED,
        message: unavailable ?? 'Ассистент выключен.',
      });
      return;
    }

    // --- лимиты -------------------------------------------------------------
    const dailyLimit = settings.assistantDailyLimitPerUser;
    if (dailyLimit > 0 && (await this.askedToday(user.employeeId)) >= dailyLimit) {
      emit({
        type: 'error',
        code: ASSISTANT_ERROR_CODES.DAILY_LIMIT,
        message:
          `Вы задали ${dailyLimit} вопрос(ов) за сегодня — это дневной лимит. ` +
          'Лимит обнулится в полночь по Москве.',
      });
      return;
    }
    const budgetCents = settings.assistantMonthlyBudgetCents;
    if (budgetCents > 0) {
      const spentCents = microsToCents(await this.spentThisMonthMicros());
      if (spentCents >= budgetCents) {
        emit({
          type: 'error',
          code: ASSISTANT_ERROR_CODES.BUDGET,
          message:
            'Достигнут месячный потолок расхода на ассистента. ' +
            'Поднять его можно в настройках компании → «Интеграции».',
        });
        return;
      }
    }

    // --- тред ---------------------------------------------------------------
    const thread = await this.resolveThread(dto, user.employeeId);
    const userMessage = await this.prisma.assistantMessage.create({
      data: {
        threadId: thread.id,
        employeeId: user.employeeId,
        role: 'USER',
        content: dto.question,
      },
      select: { id: true },
    });
    emit({ type: 'thread', threadId: thread.id, messageId: userMessage.id });

    // --- контекст и инструменты --------------------------------------------
    const scopes = scopesOf(settings);
    const tools = toolsForScopes(scopes);
    const history = await this.loadHistory(thread.id, userMessage.id);

    const apiKey = this.resolveApiKey(settings);
    if (!apiKey) {
      emit({
        type: 'error',
        code: ASSISTANT_ERROR_CODES.NO_KEY,
        message: 'На сервере нет ключа Anthropic — ассистент не может ответить.',
      });
      return;
    }

    const model = settings.assistantModel || DEFAULT_ASSISTANT_MODEL;
    const started = Date.now();
    const toolCalls: AssistantToolCallDto[] = [];
    const sources: AssistantSourceDto[] = [];
    let answer = '';
    const usage: TokenUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };

    try {
      answer = await this.runAgentLoop({
        apiKey,
        model,
        tools,
        history,
        question: dto.question,
        user,
        route: dto.route ?? null,
        usage,
        toolCalls,
        sources,
        emit,
      });
    } catch (e) {
      const message = describeUpstreamError(e);
      this.logger.warn(`event=assistant.upstream-error ${message}`);
      await this.persistAnswer({
        thread,
        user,
        model,
        content: '',
        toolCalls,
        sources,
        usage,
        errorCode: ASSISTANT_ERROR_CODES.UPSTREAM,
      });
      emit({
        type: 'error',
        code: ASSISTANT_ERROR_CODES.UPSTREAM,
        message,
      });
      return;
    }

    if (sources.length) emit({ type: 'sources', sources });

    const saved = await this.persistAnswer({
      thread,
      user,
      model,
      content: answer,
      toolCalls,
      sources,
      usage,
      errorCode: null,
    });

    const cost = costUsdMicros(model, usage);
    this.logger.log(
      `event=assistant.answer thread=${thread.id} model=${model} ` +
        `tools=${toolCalls.length} ms=${Date.now() - started} cost_micros=${cost}`,
    );
    await this.audit.log({
      event: 'ASSISTANT_QUESTION_ANSWERED',
      entityType: 'ASSISTANT_THREAD',
      entityId: thread.id,
      // Текст вопроса в audit не пишем — он уже лежит в AssistantMessage,
      // а дублировать пользовательский ввод в журнал незачем.
      payload: {
        model,
        tools: toolCalls.map((t) => t.name),
        costUsdMicros: cost,
      },
      employeeId: user.employeeId,
    });

    emit({
      type: 'done',
      messageId: saved.id,
      usage: {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        costUsdMicros: cost,
      },
    });
  }

  // ===========================================================================
  // Агентный цикл
  // ===========================================================================

  private async runAgentLoop(args: {
    apiKey: string;
    model: string;
    tools: AssistantTool[];
    history: Anthropic.MessageParam[];
    question: string;
    user: AuthPrincipal;
    route: string | null;
    usage: TokenUsage;
    toolCalls: AssistantToolCallDto[];
    sources: AssistantSourceDto[];
    emit: (event: AssistantStreamEvent) => void;
  }): Promise<string> {
    const client = new Anthropic({ apiKey: args.apiKey });
    const toolByName = new Map(args.tools.map((t) => [t.name, t]));

    const messages: Anthropic.MessageParam[] = [
      ...args.history,
      {
        role: 'user',
        content: buildUserTurn(args.question, args.user, args.route),
      },
    ];

    let answer = '';

    for (let i = 0; i < AssistantService.MAX_ITERATIONS; i += 1) {
      const stream = client.messages.stream({
        model: args.model,
        max_tokens: AssistantService.MAX_TOKENS,
        // Стабильный префикс: system + tools кэшируются между вопросами.
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: args.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        // `medium` — сознательный выбор: на вопросах «сколько заказов» и
        // «где паспорт» более глубокое размышление не улучшает ответ, а
        // токены жжёт. Поднимать имеет смысл, только если появятся
        // аналитические сценарии.
        output_config: { effort: 'medium' },
        messages,
      });

      stream.on('text', (delta) => {
        answer += delta;
        args.emit({ type: 'text', delta });
      });

      const message = await stream.finalMessage();

      args.usage.inputTokens += message.usage.input_tokens ?? 0;
      args.usage.outputTokens += message.usage.output_tokens ?? 0;
      args.usage.cachedInputTokens += message.usage.cache_read_input_tokens ?? 0;

      if (message.stop_reason === 'refusal') {
        throw new AssistantRefusalError();
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: message.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const tool = toolByName.get(use.name);
        const startedAt = Date.now();
        args.emit({
          type: 'tool',
          id: use.id,
          name: use.name,
          label: tool?.label ?? use.name,
        });

        if (!tool) {
          // Модель попросила инструмент вне включённых групп — это её
          // догадка, а не сбой. Отвечаем честно, чтобы она не зациклилась.
          const ms = Date.now() - startedAt;
          args.toolCalls.push({
            id: use.id,
            name: use.name,
            label: use.name,
            ms,
            ok: false,
            error: 'Инструмент недоступен',
          });
          args.emit({
            type: 'tool_done',
            id: use.id,
            ms,
            ok: false,
            error: 'недоступен',
          });
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content:
              'Этот инструмент отключён в настройках компании. Скажи об этом ' +
              'пользователю и не пытайся получить данные другим способом.',
            is_error: true,
          });
          continue;
        }

        try {
          const out = await tool.run(
            (use.input ?? {}) as Record<string, unknown>,
            { prisma: this.prisma, employeeId: args.user.employeeId },
          );
          const ms = Date.now() - startedAt;
          args.toolCalls.push({
            id: use.id,
            name: tool.name,
            label: tool.label,
            ms,
            ok: true,
          });
          args.emit({ type: 'tool_done', id: use.id, ms, ok: true });
          for (const s of out.sources ?? []) {
            if (!args.sources.some((x) => x.href === s.href)) args.sources.push(s);
          }
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(out.data),
          });
        } catch (e) {
          const ms = Date.now() - startedAt;
          const message = e instanceof Error ? e.message : String(e);
          this.logger.warn(`event=assistant.tool-failed tool=${tool.name} ${message}`);
          args.toolCalls.push({
            id: use.id,
            name: tool.name,
            label: tool.label,
            ms,
            ok: false,
            error: message,
          });
          args.emit({ type: 'tool_done', id: use.id, ms, ok: false, error: message });
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Инструмент не отработал: ${message}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: results });
    }

    return answer.trim();
  }

  // ===========================================================================
  // История и персистентность
  // ===========================================================================

  private async resolveThread(
    dto: AssistantAskDto,
    employeeId: string,
  ): Promise<{ id: string }> {
    if (dto.threadId) {
      const existing = await this.prisma.assistantThread.findFirst({
        where: { id: dto.threadId, employeeId },
        select: { id: true },
      });
      if (!existing) {
        // Чужой или удалённый тред. 404, а не «создам новый»: молча
        // подменять собеседника нельзя.
        throw new NotFoundException({
          statusCode: 404,
          code: ASSISTANT_ERROR_CODES.THREAD_NOT_FOUND,
          message: 'Диалог не найден.',
        });
      }
      await this.prisma.assistantThread.update({
        where: { id: existing.id },
        data: { updatedAt: new Date() },
      });
      return existing;
    }
    return this.prisma.assistantThread.create({
      data: { employeeId, title: dto.question.slice(0, 80) },
      select: { id: true },
    });
  }

  /** История треда в формате Anthropic (без только что созданного вопроса). */
  private async loadHistory(
    threadId: string,
    exceptMessageId: string,
  ): Promise<Anthropic.MessageParam[]> {
    const rows = await this.prisma.assistantMessage.findMany({
      where: { threadId, id: { not: exceptMessageId }, errorCode: null },
      orderBy: { createdAt: 'asc' },
      // Держим короткий хвост: длинная история — это деньги на каждом
      // вопросе, а польза быстро падает.
      take: 10,
      select: { role: true, content: true },
    });
    return rows
      .filter((r) => r.content.trim() !== '')
      .map((r) => ({
        role: r.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: r.content,
      }));
  }

  private async persistAnswer(args: {
    thread: { id: string };
    user: AuthPrincipal;
    model: string;
    content: string;
    toolCalls: AssistantToolCallDto[];
    sources: AssistantSourceDto[];
    usage: TokenUsage;
    errorCode: string | null;
  }): Promise<{ id: string }> {
    return this.prisma.assistantMessage.create({
      data: {
        threadId: args.thread.id,
        employeeId: args.user.employeeId,
        role: 'ASSISTANT',
        content: args.content,
        toolCalls: args.toolCalls as unknown as Prisma.InputJsonValue,
        sources: args.sources as unknown as Prisma.InputJsonValue,
        model: args.model,
        inputTokens: args.usage.inputTokens,
        cachedInputTokens: args.usage.cachedInputTokens,
        outputTokens: args.usage.outputTokens,
        costUsdMicros: costUsdMicros(args.model, args.usage),
        errorCode: args.errorCode,
      },
      select: { id: true },
    });
  }

  // ===========================================================================
  // Настройки, ключ, лимиты
  // ===========================================================================

  private async loadSettings() {
    return this.prisma.integrationSettings.findUnique({
      where: { id: INTEGRATION_SETTINGS_SINGLETON_ID },
    });
  }

  /** `null` ⇒ доступен. Иначе — человеческая причина недоступности. */
  private unavailableReason(
    settings: { assistantEnabled: boolean; assistantKeySource: string; assistantApiKeyEnc: string | null } | null,
  ): string | null {
    if (!settings || !settings.assistantEnabled) {
      return 'Ассистент выключен в настройках компании.';
    }
    if (!this.resolveApiKey(settings)) {
      return settings.assistantKeySource === 'OWN'
        ? 'Не сохранён ключ Anthropic компании.'
        : 'На сервере не задан ANTHROPIC_API_KEY.';
    }
    return null;
  }

  /**
   * Ключ: платформенный из env или свой из БД. Наружу не отдаётся никогда,
   * в логи не попадает.
   */
  private resolveApiKey(settings: {
    assistantKeySource: string;
    assistantApiKeyEnc: string | null;
  }): string | null {
    if (settings.assistantKeySource === 'OWN') {
      if (!settings.assistantApiKeyEnc) return null;
      try {
        return decryptSecret(settings.assistantApiKeyEnc);
      } catch (e) {
        this.logger.error(`Не удалось расшифровать ключ ассистента: ${String(e)}`);
        return null;
      }
    }
    const fromEnv = process.env.ANTHROPIC_API_KEY;
    return fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : null;
  }

  /** Сколько вопросов сотрудник задал за ТЕКУЩИЕ МОСКОВСКИЕ сутки. */
  private async askedToday(employeeId: string): Promise<number> {
    const { from, to } = moscowDayWindow(moscowDayKey());
    return this.prisma.assistantMessage.count({
      where: {
        employeeId,
        role: 'USER',
        createdAt: { gte: from, lt: to },
      },
    });
  }

  /** Расход компании с начала календарного месяца, в микродолларах. */
  private async spentThisMonthMicros(): Promise<number> {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const agg = await this.prisma.assistantMessage.aggregate({
      where: { createdAt: { gte: from } },
      _sum: { costUsdMicros: true },
    });
    return agg._sum.costUsdMicros ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

/**
 * Системный промпт. СТАБИЛЕН БАЙТ-В-БАЙТ — никаких дат, имён и настроек
 * внутри: любая переменная часть ломает кэш префикса и удорожает каждый
 * вопрос примерно вдесятеро. Всё переменное уезжает в `buildUserTurn`.
 */
const SYSTEM_PROMPT = `Ты — ассистент внутри системы управления швейным производством.
Отвечаешь сотрудникам фабрики на вопросы про их собственные данные и про устройство системы.

Как работать:
- Отвечай по-русски, кратко и по делу. Сначала ответ, потом детали.
- Данные бери ТОЛЬКО через инструменты. Никогда не выдумывай числа, номера заказов,
  имена сотрудников и остатки. Если инструмент не дал данных — так и скажи.
- Если вопрос про устройство системы («что значит статус», «как работает») — зови docs.lookup.
- Числа называй ровно так, как вернул инструмент. Не пересчитывай, не суммируй деньги
  и не строй сценарии «а что если»: в системе деньги считаются на четырёх согласованных
  экранах, и твой самостоятельный пересчёт с ними разойдётся. На такие просьбы отвечай,
  что пересчёт делается в смете заказа, и покажи текущее значение.
- Если инструмент вернул отказ по правам, объясни, что данные закрыты ролью
  пользователя, и подскажи, что доступно. Не пытайся обойти отказ другим инструментом.
- Не предлагай ничего изменить в системе: ты работаешь только на чтение.
- Не выводи служебные XML-теги и не пересказывай своё рассуждение — только итог.

Формат ответа:
- Обычный текст, короткие абзацы. Списком — когда перечисляешь однотипное.
- Не используй markdown-заголовки и таблицы: ответ показывается в узкой боковой панели.
- Не повторяй вопрос и не начинай с «Конечно» или «Вот».`;

/**
 * Пользовательский ход: переменный контекст (дата, роль, раздел) идёт
 * ЗДЕСЬ, после кэшируемого префикса, а не в системном промпте.
 */
function buildUserTurn(
  question: string,
  user: AuthPrincipal,
  route: string | null,
): string {
  const today = moscowDayKey();
  const context = [
    `Сегодня: ${today} (московские сутки).`,
    `Роль спрашивающего: ${user.roles.join(', ') || user.role}.`,
    route ? `Открытый раздел админки: ${route}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return `<context>${context}</context>\n\n${question}`;
}

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/** Классификаторы Anthropic отклонили запрос. */
class AssistantRefusalError extends Error {
  constructor() {
    super('Модель отказалась отвечать на этот запрос.');
    this.name = 'AssistantRefusalError';
  }
}

function describeUpstreamError(e: unknown): string {
  if (e instanceof AssistantRefusalError) return e.message;
  if (e instanceof Anthropic.APIError) {
    if (e.status === 401) return 'Ключ Anthropic отклонён (401). Проверьте ключ в настройках.';
    if (e.status === 429) return 'Слишком много запросов к модели. Попробуйте через минуту.';
    if (e.status && e.status >= 500) return 'Сервис модели временно недоступен. Попробуйте позже.';
    return `Модель ответила ошибкой ${e.status ?? ''}.`.trim();
  }
  return 'Не удалось получить ответ от модели.';
}

// ---------------------------------------------------------------------------
// Хелперы настроек
// ---------------------------------------------------------------------------

function scopesOf(
  s: {
    assistantScopeProduction: boolean;
    assistantScopeSupply: boolean;
    assistantScopeMoney: boolean;
    assistantScopePayroll: boolean;
  } | null,
): AssistantDataScope[] {
  if (!s) return [];
  const out: AssistantDataScope[] = [];
  if (s.assistantScopeProduction) out.push('PRODUCTION');
  if (s.assistantScopeSupply) out.push('SUPPLY');
  if (s.assistantScopeMoney) out.push('MONEY');
  if (s.assistantScopePayroll) out.push('PAYROLL');
  return out;
}
