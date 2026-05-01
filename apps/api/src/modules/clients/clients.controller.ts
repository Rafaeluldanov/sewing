import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateClientSchema,
  ListClientsQuerySchema,
  UpdateClientSchema,
  type CreateClientDto,
  type ListClientsQuery,
  type UpdateClientDto,
} from '@sewing/shared/clients';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ClientsService } from './clients.service.js';

/**
 * Контроллер блока «Клиенты».
 *
 *   GET   /api/clients          — список (по умолчанию активные, поиск по name)
 *   POST  /api/clients          — создание новой карточки
 *   GET   /api/clients/:id      — карточка
 *   PATCH /api/clients/:id      — правка (включая мягкое отключение)
 *
 * RBAC — `SHOP_MANAGER`/`ADMIN`. Карточки клиентов видит и правит
 * только управленческий слой; рабочим ролям эта информация не нужна
 * и в их UI не показывается.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListClientsQuerySchema))
    query: ListClientsQuery,
  ) {
    return this.clients.list(query);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateClientSchema))
    body: CreateClientDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.clients.create(body, user.employeeId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.clients.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateClientSchema))
    body: UpdateClientDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.clients.update(id, body, user.employeeId);
  }
}
