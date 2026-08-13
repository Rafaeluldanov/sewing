import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import {
  AssistantAskSchema,
  type AssistantAskDto,
  type AssistantStreamEvent,
} from '@sewing/shared/assistant';
import type { Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { AssistantService } from './assistant.service.js';

/**
 * Контроллер ассистента — окно диалога с ИИ в админке.
 *
 *   GET  /api/assistant/config — доступен ли, какая модель, остаток лимита
 *   POST /api/assistant/ask    — вопрос; ответ приходит потоком (SSE)
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN`: те же роли, что открывают админку.
 * Внутри ассистент не расширяет права ни на йоту: инструменты ходят в БД
 * тенанта текущего запроса, а группы данных режутся настройками.
 *
 * Почему SSE, а не обычный JSON: агентный проход с инструментами живёт
 * 5–30 секунд, и молчащее окно всё это время читается как «сломалось».
 * nginx на `/api/` уже проксирует с `proxy_buffering off`
 * (см. `nginx/conf.d/*.conf`), так что события доходят по мере генерации.
 *
 * ВАЖНО: обработчик пишет в `Response` сам и не возвращает значение —
 * иначе Nest попытается сериализовать ответ поверх уже открытого потока.
 * Весь цикл живёт внутри обработчика, чтобы не потерять `TenantContext`
 * (AsyncLocalStorage): обращение к Prisma вне контекста запроса падает.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('config')
  config(@CurrentUser() user: AuthPrincipal) {
    return this.assistant.getConfig(user);
  }

  @Post('ask')
  async ask(
    @Body(new ZodValidationPipe(AssistantAskSchema)) body: AssistantAskDto,
    @CurrentUser() user: AuthPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Подстраховка на случай прокси без `proxy_buffering off`.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    const emit = (event: AssistantStreamEvent): void => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await this.assistant.ask(body, user, emit);
    } catch (e) {
      // Сюда попадают только неожиданные падения: ожидаемые отказы
      // (лимит, выключено, ошибка модели) сервис отдаёт событием `error`.
      // Заголовки уже ушли, поэтому обычный exception-filter бессилен —
      // сообщаем в поток и закрываем его сами.
      emit({
        type: 'error',
        code: 'ASSISTANT_INTERNAL_ERROR',
        message:
          e instanceof Error && e.message
            ? e.message
            : 'Внутренняя ошибка ассистента.',
      });
    } finally {
      if (!closed) res.end();
    }
  }
}
