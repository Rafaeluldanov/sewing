import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CreateMasterCallSchema,
  ResolveMasterCallByQrSchema,
  type CreateMasterCallDto,
  type MasterCallDto,
  type ResolveMasterCallByQrDto,
} from '@sewing/shared/master-calls';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { MasterCallsService } from './master-calls.service.js';

/**
 * REST-контракт модуля «Мастер цеха» (MVP).
 *
 * Маршруты и RBAC синхронизированы с `docs/api.md §«Master calls»`,
 * `docs/flows.md §«Вызов мастера»` и таблицей ролей (`docs/screens.md`).
 *
 *   POST /api/master-calls
 *     Кнопка «Мастер» на рабочих терминалах. Доступна всем рабочим
 *     ролям, которые реально стоят за станком и могут позвать мастера:
 *     SEAMSTRESS, CUTTER, CUTTER_ASSISTANT, QC, IRONING, PACKING.
 *     Идемпотентно (см. `MasterCallsService.create`).
 *
 *   GET /api/master-calls
 *     Очередь открытых вызовов для `/master`. Видят SHOPFLOOR_MASTER,
 *     SHOP_MANAGER, ADMIN — те же три роли, что управляют цехом и
 *     дашбордом.
 *
 *   POST /api/master-calls/resolve-by-employee-qr
 *     Закрытие вызова сканом QR сотрудника на `/master`. RBAC тот же,
 *     что и на чтение: только мастер цеха, начальник цеха и админ
 *     имеют право снять вызов.
 *
 * Контроллер сознательно тонкий: вся бизнес-логика — в `MasterCallsService`.
 */
@Controller('master-calls')
@Roles(
  'SEAMSTRESS',
  'CUTTER',
  'CUTTER_ASSISTANT',
  'QC',
  'IRONING',
  'PACKING',
  'SHOPFLOOR_MASTER',
  'SHOP_MANAGER',
)
export class MasterCallsController {
  constructor(private readonly service: MasterCallsService) {}

  /**
   * `POST /api/master-calls` — рабочий нажал «Мастер» на своём
   * терминале. Body опционален. Возвращает текущий открытый вызов
   * сотрудника (новый или уже существовавший — см. идемпотентность в
   * сервисе).
   */
  @Post()
  create(
    @CurrentUser() user: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateMasterCallSchema))
    dto: CreateMasterCallDto,
  ): Promise<MasterCallDto> {
    return this.service.create(user, dto);
  }

  /**
   * `GET /api/master-calls` — список `OPEN`-вызовов для очереди на
   * `/master`. RBAC дополнительно сужен на уровне эндпоинта (метод
   * `@Roles` сильнее, чем класс), чтобы рабочие роли не видели чужие
   * вызовы.
   */
  @Get()
  @Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
  list(): Promise<MasterCallDto[]> {
    return this.service.listOpen();
  }

  /**
   * `POST /api/master-calls/resolve-by-employee-qr` — мастер цеха
   * сканирует QR сотрудника, чтобы закрыть его открытый вызов.
   *
   * RBAC сужен до SHOPFLOOR_MASTER + SHOP_MANAGER (ADMIN получает
   * доступ автоматически через глобальный guard, см. `auth.guard.ts`).
   * Тело валидируется Zod; payload `qr` ожидается в формате
   * `EMPLOYEE:<id>` (см. `EMPLOYEE_QR_PREFIX`).
   */
  @Post('resolve-by-employee-qr')
  @Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
  resolveByEmployeeQr(
    @CurrentUser() user: AuthPrincipal,
    @Body(new ZodValidationPipe(ResolveMasterCallByQrSchema))
    dto: ResolveMasterCallByQrDto,
  ): Promise<MasterCallDto> {
    return this.service.resolveByEmployeeQr(user, dto);
  }
}
