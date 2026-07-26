import {
  AnyFilesInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
// `FilesInterceptor` используется в `saveDraft` (создание задачи менеджером);
// `AnyFilesInterceptor` — в `complete`, потому что имена файловых полей
// зависят от sizeId-ов задачи и не известны заранее.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { memoryStorage } from 'multer';
import {
  COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX,
  CONSTRUCTOR_TASK_FILE_MAX_COUNT,
  CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
  CompleteConstructorTaskSchema,
  ConstructorTaskListScopeSchema,
  CreateConstructorTaskForPatternSchema,
  REWORK_CONSTRUCTOR_TASK_FILE_FIELD,
  RequestReworkConstructorTaskSchema,
  SaveConstructorDraftSchema,
  UpdateConstructorTaskCommentSchema,
  type ConstructorTaskDetailDto,
  type ConstructorTaskSummaryDto,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';

import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';

import { ConstructorTaskFileInvalidException } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ConstructorTasksService } from './constructor-tasks.service.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * `/api/constructor-tasks` — заявки конструктору (этап «Отправить
 * изделие конструктору») и кабинет конструктора.
 *
 * RBAC:
 *   - `GET /` (список всех задач, админ-страница) — `ADMIN`,
 *     `SHOP_MANAGER`;
 *   - `GET /my` (список для кабинета) — `CONSTRUCTOR`, `ADMIN`,
 *     `SHOP_MANAGER` (последние два — для отладки);
 *   - `GET /:id` (детальная карточка) — `ADMIN`, `SHOP_MANAGER`,
 *     `CONSTRUCTOR`;
 *   - `POST /` (создание задачи + DRAFT-pattern из формы заказа) —
 *     `ADMIN`, `SHOP_MANAGER`;
 *   - `POST /:id/cancel` — `ADMIN`, `SHOP_MANAGER`;
 *   - `POST /:id/assign-self` — `CONSTRUCTOR`, `ADMIN`, `SHOP_MANAGER`;
 *   - `PATCH /:id/comment` — `CONSTRUCTOR`, `ADMIN`, `SHOP_MANAGER`;
 *   - `POST /:id/complete` (multipart с готовыми DXF) — `CONSTRUCTOR`,
 *     `ADMIN`, `SHOP_MANAGER`.
 *
 * `enforceOwnership`-флаг сервису передаём `true` только для роли
 * `CONSTRUCTOR` — обычный конструктор работает только со своими
 * задачами; ADMIN/SHOP_MANAGER могут вмешаться в любую (для отладки
 * пилота / разруливания «застрявших» задач).
 */
@Controller('constructor-tasks')
export class ConstructorTasksController {
  constructor(private readonly tasks: ConstructorTasksService) {}

  @Get()
  @Roles('ADMIN', 'SHOP_MANAGER')
  list(
    @Query('search') search?: string,
  ): Promise<ConstructorTaskSummaryDto[]> {
    return this.tasks.list(search);
  }

  /**
   * Массовые операции архива со списка `/admin/constructor-tasks`
   * (контракт — `@sewing/shared/archive`): `archivedAt := now` →
   * обратно → удалить навсегда (только из архива; вместе с заявкой
   * уходят её строки размеров и вложения, DRAFT-лекало остаётся).
   * Ответ — частичный успех.
   *
   * Объявлены ДО `@Get(':id')` для читаемости; конфликта нет —
   * одноимённого `@Post(':id')` в контроллере не существует.
   */
  @Post('archive')
  @Roles('ADMIN', 'SHOP_MANAGER')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.tasks.archiveMany(dto.ids, user.employeeId);
  }

  @Post('restore')
  @Roles('ADMIN', 'SHOP_MANAGER')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.tasks.restoreMany(dto.ids, user.employeeId);
  }

  @Post('purge')
  @Roles('ADMIN', 'SHOP_MANAGER')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.tasks.purgeMany(dto.ids, user.employeeId);
  }

  /**
   * Список задач для кабинета конструктора (`apps/web/app/constructor/`).
   * Фильтр `scope` — `mine` / `pool` / `all` (default: `all`). См.
   * `ConstructorTaskListScopeSchema` для семантики.
   *
   * `employeeId` берём из `@CurrentUser()`. Если у залогиненного
   * пользователя по какой-то причине нет привязанного `Employee`
   * (синтетическая учётка) — возвращаем `pool` без личных задач,
   * чтобы UI не падал.
   */
  @Get('my')
  @Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')
  listMy(
    @CurrentUser() user: AuthPrincipal,
    @Query('scope') scopeRaw?: string,
  ): Promise<ConstructorTaskSummaryDto[]> {
    const scope = ConstructorTaskListScopeSchema.parse(scopeRaw ?? 'all');
    const employeeId = user.employeeId ?? null;
    if (!employeeId) {
      return this.tasks.listForConstructor('__none__', 'pool');
    }
    return this.tasks.listForConstructor(employeeId, scope);
  }

  @Get(':id')
  @Roles('ADMIN', 'SHOP_MANAGER', 'CONSTRUCTOR')
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
   * Конструктор берёт задачу в работу из своего кабинета
   * (`/constructor/[id]` → кнопка «Взять в работу»). См.
   * `ConstructorTasksService.assignSelf` для семантики идемпотентности
   * и переходов статуса.
   */
  @Post(':id/assign-self')
  @Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')
  assignSelf(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ConstructorTaskDetailDto> {
    if (!user.employeeId) {
      throw new ConstructorTaskFileInvalidException(
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
      );
    }
    return this.tasks.assignSelf(
      id,
      user.employeeId,
      user.role === 'CONSTRUCTOR',
    );
  }

  /**
   * Перезаписать комментарий задачи. Поле общее с менеджером
   * (`saveDraft.comment`), на MVP это compromise: история комментариев
   * — отдельным потоком на будущее.
   */
  @Patch(':id/comment')
  @Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')
  updateComment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ConstructorTaskDetailDto> {
    const parsed = UpdateConstructorTaskCommentSchema.safeParse(body);
    if (!parsed.success) {
      throw new ConstructorTaskFileInvalidException(
        parsed.error.issues.map((i) => i.message).join('; ') ||
          'Невалидный payload.',
      );
    }
    if (!user.employeeId) {
      throw new ConstructorTaskFileInvalidException(
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
      );
    }
    return this.tasks.updateComment(
      id,
      user.employeeId,
      parsed.data.comment,
      user.role === 'CONSTRUCTOR',
    );
  }

  /**
   * Завершить задачу (`status` → DONE) с загрузкой готовых DXF-лекал.
   *
   * Запрос `multipart/form-data`:
   *   - `payload` — JSON `CompleteConstructorTaskDto` (маппинг
   *     `sizeId` → `fileFieldName`);
   *   - поля файлов — по одному на каждый размер из `task.sizeRows`
   *     с именем `file_<sizeId>` (см.
   *     `COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX`).
   *
   * Используем `AnyFilesInterceptor`, потому что заранее не знаем
   * имена файловых полей (они зависят от sizeId-ов задачи) — нельзя
   * использовать `FilesInterceptor('files', ...)` с фиксированным
   * именем поля. Лимит размера/количества прокидываем тот же, что у
   * `saveDraft` — 50MB на файл, 64 файла суммарно (с запасом, т.к.
   * `task.sizeRows` ограничен 64 в shared-схеме).
   */
  @Post(':id/complete')
  @Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: {
        fileSize: CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
        files: 64,
      },
    }),
  )
  async complete(
    @Param('id') id: string,
    @Body('payload') payloadRaw: string | undefined,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ConstructorTaskDetailDto> {
    if (!user.employeeId) {
      throw new ConstructorTaskFileInvalidException(
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
      );
    }
    if (typeof payloadRaw !== 'string' || payloadRaw.trim() === '') {
      throw new ConstructorTaskFileInvalidException(
        'Поле payload обязательно — передайте JSON со списком sizeFiles.',
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
    const parsed = CompleteConstructorTaskSchema.safeParse(payloadJson);
    if (!parsed.success) {
      throw new ConstructorTaskFileInvalidException(
        parsed.error.issues.map((i) => i.message).join('; ') ||
          'Невалидный payload.',
      );
    }
    return this.tasks.complete(
      id,
      user.employeeId,
      parsed.data,
      Array.isArray(files) ? files : [],
      user.role === 'CONSTRUCTOR',
    );
  }

  /**
   * Менеджер «Принять» — `PENDING_ACCEPT` → `DONE`, `PatternItem`
   * становится `ACTIVE`. См. `ConstructorTasksService.accept`.
   *
   * RBAC: только `ADMIN`/`SHOP_MANAGER`. `CONSTRUCTOR` не может
   * принимать собственную работу.
   */
  @Post(':id/accept')
  @Roles('ADMIN', 'SHOP_MANAGER')
  acceptTask(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ConstructorTaskDetailDto> {
    if (!user.employeeId) {
      throw new ConstructorTaskFileInvalidException(
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
      );
    }
    return this.tasks.accept(id, user.employeeId);
  }

  /**
   * Менеджер «Вернуть на доработку» — `PENDING_ACCEPT` → `REWORK`.
   * Multipart-запрос:
   *   - `payload` (string JSON) — `{ comment: string }` (обязательно
   *     заполнен; см. `RequestReworkConstructorTaskSchema`);
   *   - `rework_files` (file[]) — приложенные файлы замечаний (любой
   *     формат), сохраняются как `ConstructorTaskFile` с
   *     `direction='REWORK'`.
   *
   * `AnyFilesInterceptor` (а не `FilesInterceptor('rework_files', ...)`) —
   * чтобы не падать при отсутствии файлового поля совсем (комментарий
   * без файлов — нормальный кейс). Сами поля фильтруем по имени ниже.
   */
  @Post(':id/rework')
  @Roles('ADMIN', 'SHOP_MANAGER')
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: {
        fileSize: CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
        files: CONSTRUCTOR_TASK_FILE_MAX_COUNT,
      },
    }),
  )
  async requestRework(
    @Param('id') id: string,
    @Body('payload') payloadRaw: string | undefined,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<ConstructorTaskDetailDto> {
    if (!user.employeeId) {
      throw new ConstructorTaskFileInvalidException(
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
      );
    }
    if (typeof payloadRaw !== 'string' || payloadRaw.trim() === '') {
      throw new ConstructorTaskFileInvalidException(
        'Поле payload обязательно — передайте JSON с комментарием.',
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
    const parsed = RequestReworkConstructorTaskSchema.safeParse(payloadJson);
    if (!parsed.success) {
      throw new ConstructorTaskFileInvalidException(
        parsed.error.issues.map((i) => i.message).join('; ') ||
          'Невалидный payload.',
      );
    }
    const reworkFiles = Array.isArray(files)
      ? files.filter((f) => f.fieldname === REWORK_CONSTRUCTOR_TASK_FILE_FIELD)
      : [];
    return this.tasks.requestRework(
      id,
      user.employeeId,
      parsed.data.comment,
      reworkFiles,
    );
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
    @Query('createDraftOrder') createDraftOrderRaw?: string,
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
    // Опциональный флаг — UI на `/admin/orders/new` передаёт `true`,
    // чтобы backend в той же транзакции создал DRAFT-Order и привязал
    // pattern. Любое другое значение трактуем как `false`.
    const createDraftOrder = createDraftOrderRaw === 'true';
    return this.tasks.saveDraft(
      parsed.data,
      Array.isArray(files) ? files : [],
      user.employeeId ?? null,
      createDraftOrder,
    );
  }

  /**
   * Создать заявку конструктору для УЖЕ существующего лекала (без
   * создания нового PatternItem). Используется кнопкой «Отправить
   * конструктору» на карточке заказа `/admin/orders/[id]/edit` и
   * карточке номенклатуры `/admin/patterns/[id]`.
   *
   * Запрос: `multipart/form-data`, как у `POST /` — поле `payload`
   * (JSON `CreateConstructorTaskForPatternDto`) + `files` (file[]).
   */
  @Post('for-pattern')
  @Roles('ADMIN', 'SHOP_MANAGER')
  @UseInterceptors(
    FilesInterceptor('files', CONSTRUCTOR_TASK_FILE_MAX_COUNT, {
      storage: memoryStorage(),
      limits: {
        fileSize: CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES,
      },
    }),
  )
  async createForPattern(
    @Body('payload') payloadRaw: string | undefined,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SaveConstructorDraftResultDto> {
    if (typeof payloadRaw !== 'string' || payloadRaw.trim() === '') {
      throw new ConstructorTaskFileInvalidException(
        'Поле payload обязательно — передайте JSON с patternItemId, sizeRows и комментарием.',
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
    const parsed = CreateConstructorTaskForPatternSchema.safeParse(payloadJson);
    if (!parsed.success) {
      throw new ConstructorTaskFileInvalidException(
        parsed.error.issues
          .map((i) => i.message)
          .filter(Boolean)
          .join('; ') || 'Невалидный payload.',
      );
    }
    return this.tasks.createForExistingPattern(
      parsed.data,
      Array.isArray(files) ? files : [],
      user.employeeId ?? null,
    );
  }
}
