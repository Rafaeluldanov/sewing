import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ClientDto,
  CreateClientDto,
  ListClientsQuery,
  UpdateClientDto,
} from '@sewing/shared/clients';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientNotFoundException } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис «Клиенты» — управленческий справочник карточек заказчиков.
 *
 * Скоуп MVP сознательно минимальный: list/get/create/update. Удаление
 * out-of-scope — менеджер мягко гасит карточку через PATCH
 * `{ isActive: false }`. По умолчанию `list` отдаёт только активных —
 * чтобы селект клиента в форме создания заказа не подсовывал «зомби-
 * связи».
 *
 * Аудит пишется в `AuditLog` глобальным `AuditService` (см.
 * `audit.service.ts`). События — `CLIENT_CREATED`, `CLIENT_UPDATED`,
 * `entityType = CLIENT`. Без транзакции: запись справочника — это
 * один insert/update, поэтому `audit.log` идёт fail-soft (см.
 * `AuditService.log`).
 */
@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(query: ListClientsQuery): Promise<ClientDto[]> {
    const where: Prisma.ClientWhereInput = {};
    if (!query.includeInactive) {
      where.isActive = true;
    }
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    const rows = await this.prisma.client.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toDto);
  }

  async get(id: string): Promise<ClientDto> {
    const row = await this.prisma.client.findUnique({ where: { id } });
    if (!row) throw new ClientNotFoundException();
    return toDto(row);
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  async create(
    dto: CreateClientDto,
    actorEmployeeId?: string | null,
  ): Promise<ClientDto> {
    const created = await this.prisma.client.create({
      data: {
        name: dto.name,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        comment: dto.comment ?? null,
        isActive: dto.isActive ?? true,
      },
    });
    this.logger.log(
      `event=client.create id=${created.id} name="${created.name}"`,
    );
    await this.audit.log({
      event: 'CLIENT_CREATED',
      entityType: 'CLIENT',
      entityId: created.id,
      payload: {
        name: created.name,
        phone: created.phone,
        email: created.email,
        isActive: created.isActive,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return toDto(created);
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async update(
    id: string,
    dto: UpdateClientDto,
    actorEmployeeId?: string | null,
  ): Promise<ClientDto> {
    const current = await this.prisma.client.findUnique({ where: { id } });
    if (!current) throw new ClientNotFoundException();

    const data: Prisma.ClientUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.comment !== undefined) data.comment = dto.comment;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const updated = await this.prisma.client.update({
      where: { id },
      data,
    });
    this.logger.log(
      `event=client.update id=${updated.id} name="${updated.name}" active=${updated.isActive}`,
    );
    await this.audit.log({
      event: 'CLIENT_UPDATED',
      entityType: 'CLIENT',
      entityId: updated.id,
      payload: {
        before: {
          name: current.name,
          phone: current.phone,
          email: current.email,
          isActive: current.isActive,
        },
        after: {
          name: updated.name,
          phone: updated.phone,
          email: updated.email,
          isActive: updated.isActive,
        },
      },
      employeeId: actorEmployeeId ?? null,
    });
    return toDto(updated);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ClientRow = Prisma.ClientGetPayload<{}>;

function toDto(c: ClientRow): ClientDto {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    comment: c.comment,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
