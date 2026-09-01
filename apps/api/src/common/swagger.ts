import { Logger, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { API_PREFIX } from '@sewing/shared/config';
import { SESSION_COOKIE_NAME } from '../modules/auth/cookie.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

/**
 * Swagger UI (`GET /api/docs`, JSON — `/api/docs-json`).
 *
 * В проекте DTO — это Zod-схемы (class-validator не используется), поэтому
 * стандартный `@nestjs/swagger`-экскурсовод сам по себе видит только карту
 * роутов: тела запросов/квери для него — непрозрачный `unknown`. Чтобы не
 * аннотировать ~500 роутов руками (и не получить второй дрейфующий источник
 * истины, как docs/api.md), документ обогащается АВТОМАТИЧЕСКИ:
 *
 *   1. `SwaggerModule.createDocument` строит карту путей/методов;
 *   2. проходом по route-метаданным Nest (`__routeArguments__`) находятся
 *      все `@Body(new ZodValidationPipe(S))` / `@Query(...)` / `@Param(...)`
 *      — та же схема, которой идёт валидация, конвертируется в OpenAPI
 *      через zod-to-json-schema (target: 'openApi3') и вписывается в
 *      requestBody / parameters соответствующей операции;
 *   3. теги проставляются по первому сегменту пути после `/api` — Swagger UI
 *      группирует операции по модулям без `@ApiTags` на 90+ контроллерах.
 *
 * Схемы ОТВЕТОВ не документируются: контроллеры возвращают TS-типы сервисов
 * (стираются в рантайме), Zod-схем ответов в проекте нет. Источник истины
 * по ответам — docs/api.md и сами сервисы.
 *
 * Доступ: UI живёт под `/api/...`, поэтому наружу выходит через существующие
 * nginx-локации `/api/` всех vhost-ов (dev.teeon.ru, *.dev.teeon.ru,
 * demo2.teeon.ru, prod.teeon.ru) — отдельной маршрутизации не нужно.
 * Кнопка «Try it out» работает от той же session-cookie (same-origin).
 * Аварийный выключатель: `SWAGGER_DISABLED=1`.
 */

// Литералы вместо deep-import `@nestjs/common/constants` — значения стабильны
// (Nest 10), а импорт из internals ломается под webpack-сборкой prod.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const ROUTE_ARGS_METADATA = '__routeArguments__';

// RouteParamtypes (@nestjs/common/enums) — первая часть ключа
// `__routeArguments__` (`«3:0» → @Body() в позиции 0`).
const PARAMTYPE_BODY = '3';
const PARAMTYPE_QUERY = '4';
const PARAMTYPE_PARAM = '5';

const VERB_BY_METHOD: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
};

type AnyRecord = Record<string, any>;

export function setupSwagger(app: INestApplication): void {
  if (process.env.SWAGGER_DISABLED === '1') {
    Logger.log('Swagger UI выключен (SWAGGER_DISABLED=1)', 'Swagger');
    return;
  }

  const config = new DocumentBuilder()
    .setTitle('Sewing API')
    .setDescription(
      'API системы управления швейным производством. ' +
        'Схемы body/query собраны автоматически из Zod-схем валидации ' +
        '(ZodValidationPipe) — всегда совпадают с фактическим контрактом. ' +
        'Авторизация — session-cookie: залогиньтесь в приложении на этом же ' +
        'домене, и «Try it out» будет слать запросы от вашей сессии. ' +
        'Схемы ответов см. в docs/api.md.',
    )
    .setVersion('1.0')
    .addCookieAuth(SESSION_COOKIE_NAME)
    .addSecurityRequirements('cookie')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const stats = enrichFromZodSchemas(app, document);
  tagByModule(document);

  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Sewing API',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      // Секция «Schemas» внизу пуста (именованных моделей нет) — прячем.
      defaultModelsExpandDepth: -1,
    },
  });

  Logger.log(
    `Swagger UI: ${API_PREFIX}/docs (body: ${stats.bodies}, query: ${stats.queries}, param: ${stats.params}, ошибок конвертации: ${stats.failures})`,
    'Swagger',
  );
}

/**
 * Обход всех контроллеров: по `__routeArguments__` находим ZodValidationPipe
 * на @Body/@Query/@Param и вписываем схемы в операции документа.
 */
function enrichFromZodSchemas(
  app: INestApplication,
  document: OpenAPIObject,
): { bodies: number; queries: number; params: number; failures: number } {
  const stats = { bodies: 0, queries: 0, params: 0, failures: 0 };
  const modulesContainer = app.get(ModulesContainer);

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const metatype = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      if (!metatype || typeof metatype !== 'function') continue;

      const ctrlPaths = toArray(Reflect.getMetadata(PATH_METADATA, metatype) ?? '/');
      const proto = metatype.prototype as AnyRecord;

      for (const methodName of Object.getOwnPropertyNames(proto)) {
        if (methodName === 'constructor') continue;
        const handler = proto[methodName];
        if (typeof handler !== 'function') continue;

        const methodPathsRaw = Reflect.getMetadata(PATH_METADATA, handler);
        const verbNum = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (methodPathsRaw === undefined || verbNum === undefined) continue;
        const verb = VERB_BY_METHOD[verbNum];
        if (!verb) continue;

        const routeArgs =
          (Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, methodName) as
            | Record<string, { index: number; data?: unknown; pipes?: unknown[] }>
            | undefined) ?? {};

        for (const ctrlPath of ctrlPaths) {
          for (const methodPath of toArray(methodPathsRaw)) {
            const fullPath = toOpenApiPath(API_PREFIX, ctrlPath, methodPath);
            const operation = (document.paths as AnyRecord)[fullPath]?.[verb] as
              | AnyRecord
              | undefined;
            if (!operation) continue;

            for (const [key, arg] of Object.entries(routeArgs)) {
              const paramtype = key.split(':')[0];
              const pipe = (arg.pipes ?? []).find(
                (p): p is ZodValidationPipe<unknown> => p instanceof ZodValidationPipe,
              );
              if (!pipe) continue;

              const schema = zodToOpenApiSchema(pipe.schema);
              if (!schema) {
                stats.failures += 1;
                continue;
              }

              if (paramtype === PARAMTYPE_BODY) {
                operation.requestBody = {
                  required: true,
                  content: { 'application/json': { schema } },
                };
                stats.bodies += 1;
              } else if (paramtype === PARAMTYPE_QUERY) {
                if (applyObjectParams(operation, schema, 'query')) stats.queries += 1;
                else stats.failures += 1;
              } else if (paramtype === PARAMTYPE_PARAM) {
                if (typeof arg.data === 'string' && arg.data) {
                  // @Param('id', pipe) — уточняем схему path-параметра,
                  // который explorer уже завёл по токену `:id`.
                  const existing = (operation.parameters ?? []).find(
                    (p: AnyRecord) => p.in === 'path' && p.name === arg.data,
                  );
                  if (existing) {
                    existing.schema = schema;
                    stats.params += 1;
                  }
                } else if (applyObjectParams(operation, schema, 'path')) {
                  stats.params += 1;
                }
              }
            }
          }
        }
      }
    }
  }

  return stats;
}

/**
 * Разворачивает object-схему в отдельные parameters (`in: query|path`).
 * Возвращает false, если верхний уровень схемы — не объект с properties
 * (например, `z.preprocess` без вложенного объекта): такие оставляем как есть.
 */
function applyObjectParams(
  operation: AnyRecord,
  schema: AnyRecord,
  where: 'query' | 'path',
): boolean {
  if (schema.type !== 'object' || !schema.properties) return false;
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const params = Object.entries(schema.properties as Record<string, AnyRecord>).map(
    ([name, propSchema]) => ({
      name,
      in: where,
      // path-параметры в OpenAPI обязаны быть required.
      required: where === 'path' ? true : required.includes(name),
      ...(propSchema.description ? { description: propSchema.description } : {}),
      schema: propSchema,
    }),
  );
  operation.parameters = [
    ...((operation.parameters ?? []) as AnyRecord[]).filter((p) => p.in !== where),
    ...params,
  ];
  return true;
}

function zodToOpenApiSchema(schema: unknown): AnyRecord | undefined {
  try {
    const json = zodToJsonSchema(schema as never, {
      target: 'openApi3',
      // Всё инлайном: именованных $ref-моделей не заводим, чтобы документ
      // не зависел от порядка регистрации схем.
      $refStrategy: 'none',
    }) as AnyRecord;
    delete json.$schema;
    delete json.definitions;
    return json;
  } catch {
    return undefined;
  }
}

/** `/api/orders/:id/close` (+ префикс контроллера) → `/api/orders/{id}/close`. */
function toOpenApiPath(...parts: Array<string | undefined>): string {
  const joined = ('/' + parts.filter(Boolean).join('/'))
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return (joined === '' ? '/' : joined).replace(/:([A-Za-z0-9_]+)\??/g, '{$1}');
}

/** Тег операции = первый сегмент пути после `/api` — группировка по модулям. */
function tagByModule(document: OpenAPIObject): void {
  const prefix = new RegExp(`^${API_PREFIX.replace(/\//g, '\\/')}\\/?`);
  for (const [path, item] of Object.entries(document.paths as AnyRecord)) {
    const seg = path.replace(prefix, '').split('/')[0] || 'root';
    for (const verb of Object.values(VERB_BY_METHOD)) {
      if (verb && item[verb]) item[verb].tags = [seg];
    }
  }
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}
