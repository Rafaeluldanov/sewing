import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  CONSTRUCTOR_TASK_FILE_MAX_COUNT,
  CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
  SaveConstructorDraftSchema,
  type ConstructorTaskDetailDto,
  type ConstructorTaskSummaryDto,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';

import { ConstructorTaskFileInvalidException } from '../../common/errors.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ConstructorTasksService } from './constructor-tasks.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * `/api/constructor-tasks` — заявки конструктору (этап «Отправить
 * изделие конструктору»).
 *
 * RBAC:
 *   - GET (list/detail) — `ADMIN`, `SHOP_MANAGER`. Тот же набор, что
 *     у других admin-эндпоинтов, потому что список задач — это
 *     внутренний управленческий инструмент. Кабинет конструктора
 *     (роль `CONSTRUCTOR`) будет отдельным PR;
 *   - POST — `ADMIN`, `SHOP_MANAGER`. Создаёт задачу + DRAFT-pattern
 *     + материальные area при «Сохранить изделие» на вкладке
 *     `constructor` в форме заказа.
 */
@Controller('constructor-tasks')
export class ConstructorTasksController {
  constructor(private readonly tasks: ConstructorTasksService) {}

  @Get()
  @Roles('ADMIN', 'SHOP_MANAGER')
  list(): Promise<ConstructorTaskSummaryDto[]> {
    return this.tasks.list();
  }

  @Get(':id')
  @Roles('ADMIN', 'SHOP_MANAGER')
  getOne(@Param('id') id: string): Promise<ConstructorTaskDetailDto> {
    return this.tasks.getOne(id);
  }

  /**
   * Отмена заявки конструктору. Идемпотентен — повторный вызов на
   * `CANCELLED`-задаче возвращает её же без изменений. Cancel
   * `DONE`-задачи отдаёт 409 `CONSTRUCTOR_TASK_INVALID_TRANSITION`.
   *
   * Реальная запись `ConstructorTask` остаётся в БД для аудита;
   * DRAFT-pattern не трогается (может быть привязан к заказу).
   */
  @Post(':id/cancel')
  @Roles('ADMIN', 'SHOP_MANAGER')
  cancel(@Param('id') id: string): Promise<ConstructorTaskDetailDto> {
    return this.tasks.cancel(id);
  }

  /**
   * Создать заявку конструктору + DRAFT-pattern + material areas +
   * прикреплённые файлы.
   *
   * Запрос: `multipart/form-data` с полями:
   *   - `payload` (string) — JSON-сериализованный
   *     `SaveConstructorDraftDto` (sizeRows, comment, categoryId);
   *   - `files` (file[]) — прикреплённые документы (any format,
   *     лимит размера на файл и количества — см. shared).
   *
   * Multipart выбран сознательно: иначе пришлось бы base64-кодировать
   * файлы в JSON, что неудобно для больших PDF и потребляет память.
   * JSON-payload отдельным полем — стандартный паттерн NestJS для
   * mixed body.
   */
  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  @UseInterceptors(
    FilesInterceptor('files', CONSTRUCTOR_TASK_FILE_MAX_COUNT, {
      storage: memoryStorage(),
      limits: {
        fileSize: CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
      },
    }),
  )
  async saveDraft(
    @Body('payload') payloadRaw: string | undefined,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SaveConstructorDraftResultDto> {
    if (typeof payloadRaw !== 'string' || payloadRaw.trim() === '') {
      throw new ConstructorTaskFileInvalidException(
        'Поле payload обязательно — передайте JSON с sizeRows и комментарием.',
      );
    }
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(payloadRaw);
    } catch {
      throw new ConstructorTaskFileInvalidException(
        'Поле payload содержит невалидный JSON.',
      );
    }
    const parsed = SaveConstructorDraftSchema.safeParse(payloadJson);
    if (!parsed.success) {
      throw new ConstructorTaskFileInvalidException(
        parsed.error.issues
          .map((i) => i.message)
          .filter(Boolean)
          .join('; ') || 'Невалидный payload.',
      );
    }
    return this.tasks.saveDraft(
      parsed.data,
      Array.isArray(files) ? files : [],
      user.employeeId ?? null,
    );
  }
}
