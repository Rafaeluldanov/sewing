import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { API_PREFIX } from '@sewing/shared/config';
import { GlobalExceptionFilter } from './common/global-exception.filter.js';
import { requestIdMiddleware } from './common/request-id.middleware.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.use(requestIdMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS (MVP 1.1): разрешаем сконфигурированный APP_URL и
  // дополнительный список из CORS_ALLOWED_ORIGINS (через запятую).
  // credentials = true обязательно: иначе браузер не пошлёт session-cookie
  // cross-origin (web и api на разных хостах в проде/stage).
  const origins = buildCorsOrigins();
  app.enableCors({
    origin: origins.length === 0 ? false : origins,
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`API listening on :${port} (prefix ${API_PREFIX})`, 'Bootstrap');
  Logger.log(
    `CORS allowed origins: ${origins.length ? origins.join(', ') : '(none)'}`,
    'Bootstrap',
  );
}

function buildCorsOrigins(): string[] {
  const out = new Set<string>();
  if (process.env.APP_URL) out.add(process.env.APP_URL.trim());
  if (process.env.NEXT_PUBLIC_APP_URL) out.add(process.env.NEXT_PUBLIC_APP_URL.trim());
  const extra = process.env.CORS_ALLOWED_ORIGINS;
  if (extra) {
    for (const piece of extra.split(',')) {
      const trimmed = piece.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return Array.from(out).filter(Boolean);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('API failed to start:', err);
  process.exit(1);
});
