import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Глобальный фильтр исключений (MVP 1.1, ADR-0014 §5).
 *
 * Зачем:
 *   - бизнес-ошибки (`BusinessException` и любой `HttpException`) уже
 *     приходят со структурой `{ statusCode, code, message, ... }` —
 *     передаём её клиенту как есть;
 *   - `Prisma.PrismaClientKnownRequestError` мапим в осмысленные
 *     `code`-значения, чтобы UI мог их обработать (`UNIQUE_VIOLATION`,
 *     `FOREIGN_KEY_VIOLATION`, ...);
 *   - всё остальное — `INTERNAL_ERROR` без stack trace в теле ответа.
 *
 * Цель — никогда не отдавать наружу сырые stack traces, имена таблиц и
 * SQL-фрагменты, и при этом сохранить достаточный контекст в логах.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();

    const requestId = req.requestId ?? '-';
    const payload = this.toResponse(exception, req);
    const body = { ...payload, requestId };
    if (payload.statusCode >= 500) {
      this.logger.error(
        `[${requestId}] ${req.method} ${req.url} → ${payload.statusCode} ${payload.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (payload.statusCode >= 400) {
      this.logger.warn(
        `[${requestId}] ${req.method} ${req.url} → ${payload.statusCode} ${payload.code} (${payload.message})`,
      );
    }
    if (!res.getHeader('X-Request-Id')) {
      res.setHeader('X-Request-Id', requestId);
    }
    res.status(payload.statusCode).json(body);
  }

  private toResponse(
    exception: unknown,
    _req: Request,
  ): {
    statusCode: number;
    code: string;
    message: string;
    issues?: unknown;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return { statusCode: status, code: defaultCode(status), message: body };
      }
      const obj = body as Record<string, unknown>;
      return {
        statusCode: status,
        code: (obj.code as string) ?? defaultCode(status),
        message: pickMessage(obj.message) ?? defaultMessage(status),
        ...(obj.issues ? { issues: obj.issues } : {}),
        // Структурированный payload бизнес-ошибок (`ORDER_SPEC_INCOMPLETE` —
        // какие расцветки и какие поля не заполнены; `MATERIAL_STOCK_
        // INSUFFICIENT` — сколько чего не хватает). Без проброса UI знает
        // только текст сообщения и не может подсветить конкретные плитки.
        ...(obj.details ? { details: obj.details } : {}),
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Шпаргалка: https://www.prisma.io/docs/orm/reference/error-reference
      switch (exception.code) {
        case 'P2002':
          return {
            statusCode: HttpStatus.CONFLICT,
            code: 'UNIQUE_VIOLATION',
            message: 'Нарушено уникальное ограничение.',
          };
        case 'P2003':
          return {
            statusCode: HttpStatus.CONFLICT,
            code: 'FOREIGN_KEY_VIOLATION',
            message: 'Нарушение ссылочной целостности.',
          };
        case 'P2025':
          return {
            statusCode: HttpStatus.NOT_FOUND,
            code: 'NOT_FOUND',
            message: 'Запись не найдена.',
          };
        default:
          break;
      }
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Внутренняя ошибка сервера.',
    };
  }
}

function defaultCode(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'UNPROCESSABLE_ENTITY';
  return 'ERROR';
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Нужно войти в систему.';
  if (status === 403) return 'Доступ запрещён.';
  if (status === 404) return 'Не найдено.';
  return 'Ошибка.';
}

function pickMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('; ');
  return undefined;
}
