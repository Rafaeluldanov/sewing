import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  formatCutReleasePolicyMessage,
  type CreateCutReleasePolicyDto,
  type CutReleasePolicyDto,
  type UpdateCutReleasePolicyDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CutReleasePolicyViolationException,
  PassportSizeNotInOrderException,
} from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Stage 3 «Мастер цеха» — сервис управления одной активной политикой
 * выдачи кроя (`CutReleasePolicy`).
 *
 * Контракт (см. `docs/domain.md §«Мастер цеха»`,
 * `apps/api/src/modules/cut-release-policy/cut-release-policy.controller.ts`,
 * `prisma/schema.prisma::CutReleasePolicy`):
 *
 *   - `getActive()` — текущая активная политика или `null`. Используется
 *     UI на `/master` (карточка) и `PassportsService.issueToEmployee`.
 *   - `create(actor, dto)` — создать новую политику; в той же транзакции
 *     деактивирует все предыдущие активные (MVP-инвариант «не более
 *     одной активной»). Пишет audit `CUT_RELEASE_POLICY_CREATED`.
 *   - `update(actor, id, dto)` — точечно обновить поля политики. Если
 *     `isActive` переводят в `true`, в той же транзакции отключаем все
 *     остальные активные (опять-таки MVP-инвариант). Пишет audit
 *     `CUT_RELEASE_POLICY_UPDATED`.
 *   - `disable(actor, id)` — выставить `isActive = false`. Пишет audit
 *     `CUT_RELEASE_POLICY_DISABLED`. Идемпотентен (повторный disable —
 *     no-op без дублирующего audit).
 *
 * Точки рубежа:
 *   - валидация существования `sizeId` идёт в этом сервисе (на API мы
 *     уже принимаем строку без FK; здесь убеждаемся, что справочник
 *     знает такой размер — иначе получим `SIZE_NOT_IN_ORDER` в
 *     `passports.service.ts` уже после факта);
 *   - расчёт inline-сообщения для рабочего (`Сейчас разрешена выдача
 *     только: …`) делегируем в `formatCutReleasePolicyMessage` из
 *     `@sewing/shared`, чтобы UI и backend собирали идентичный текст
 *     из одного и того же кода.
 */
@Injectable()
export class CutReleasePolicyService {
  private readonly logger = new Logger(CutReleasePolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  /**
   * Вернуть текущую активную политику (или `null`, если её нет).
   *
   * Берём «первую попавшуюся» (`findFirst`): MVP-инвариант гарантирует,
   * что активной может быть только одна. Если в БД случайно оказалось
   * две (например, после ручного апдейта), отдадим самую позднюю по
   * `updatedAt` — это безопасный default («побеждает» более свежее
   * решение мастера).
   */
  async getActive(): Promise<CutReleasePolicyDto | null> {
    const row = await this.prisma.cutReleasePolicy.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row) return null;
    return this.toDto(row);
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(
    actor: AuthPrincipal,
    dto: CreateCutReleasePolicyDto,
  ): Promise<CutReleasePolicyDto> {
    if (dto.sizeId) {
      const exists = await this.prisma.size.findUnique({
        where: { id: dto.sizeId },
        select: { id: true },
      });
      if (!exists) throw new PassportSizeNotInOrderException();
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // MVP-инвариант: одновременно активна максимум одна политика.
      // Деактивируем всех предыдущих в той же транзакции — это снимает
      // race-условие «два мастера одновременно жмут "Установить"».
      await tx.cutReleasePolicy.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
      const next = await tx.cutReleasePolicy.create({
        data: {
          isActive: true,
          color: dto.color ?? null,
          sizeId: dto.sizeId ?? null,
          limitQty: dto.limitQty,
          consumedQty: 0,
          createdById: actor.employeeId,
        },
      });
      await this.audit.log(
        {
          event: 'CUT_RELEASE_POLICY_CREATED',
          entityType: 'CUT_RELEASE_POLICY',
          entityId: next.id,
          employeeId: actor.employeeId,
          payload: {
            color: next.color,
            sizeId: next.sizeId,
            limitQty: next.limitQty,
          },
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=cutReleasePolicy.create policyId=${created.id} actor=${actor.employeeId} color=${created.color ?? '-'} sizeId=${created.sizeId ?? '-'} limitQty=${created.limitQty}`,
    );
    return this.toDto(created);
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  async update(
    actor: AuthPrincipal,
    id: string,
    dto: UpdateCutReleasePolicyDto,
  ): Promise<CutReleasePolicyDto> {
    const current = await this.prisma.cutReleasePolicy.findUnique({
      where: { id },
    });
    if (!current) {
      // Нет смысла плодить отдельную бизнес-ошибку — используем общий
      // 404 без выделенного code: `update` редко вызывается, и UI
      // обычно показывает универсальный текст «не найдено».
      throw new Error('CUT_RELEASE_POLICY_NOT_FOUND');
    }

    if (dto.sizeId !== undefined && dto.sizeId !== null) {
      const exists = await this.prisma.size.findUnique({
        where: { id: dto.sizeId },
        select: { id: true },
      });
      if (!exists) throw new PassportSizeNotInOrderException();
    }

    const data: Prisma.CutReleasePolicyUpdateInput = {};
    if (dto.color !== undefined) data.color = dto.color ?? null;
    if (dto.sizeId !== undefined) data.sizeId = dto.sizeId ?? null;
    if (dto.limitQty !== undefined) data.limitQty = dto.limitQty;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Если активируем эту политику, гасим остальные активные —
      // тот же MVP-инвариант, что и в `create`.
      if (dto.isActive === true) {
        await tx.cutReleasePolicy.updateMany({
          where: { isActive: true, NOT: { id } },
          data: { isActive: false },
        });
      }
      const next = await tx.cutReleasePolicy.update({
        where: { id },
        data,
      });
      await this.audit.log(
        {
          event: 'CUT_RELEASE_POLICY_UPDATED',
          entityType: 'CUT_RELEASE_POLICY',
          entityId: next.id,
          employeeId: actor.employeeId,
          payload: {
            before: {
              color: current.color,
              sizeId: current.sizeId,
              limitQty: current.limitQty,
              isActive: current.isActive,
            },
            after: {
              color: next.color,
              sizeId: next.sizeId,
              limitQty: next.limitQty,
              isActive: next.isActive,
            },
          },
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=cutReleasePolicy.update policyId=${id} actor=${actor.employeeId}`,
    );
    return this.toDto(updated);
  }

  // -------------------------------------------------------------------------
  // DISABLE
  // -------------------------------------------------------------------------

  async disable(
    actor: AuthPrincipal,
    id: string,
  ): Promise<CutReleasePolicyDto> {
    const current = await this.prisma.cutReleasePolicy.findUnique({
      where: { id },
    });
    if (!current) {
      throw new Error('CUT_RELEASE_POLICY_NOT_FOUND');
    }

    if (!current.isActive) {
      // Идемпотентность: повторный disable — no-op без audit, чтобы
      // двойной тап мастера не плодил дубли в журнале.
      return this.toDto(current);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.cutReleasePolicy.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.log(
        {
          event: 'CUT_RELEASE_POLICY_DISABLED',
          entityType: 'CUT_RELEASE_POLICY',
          entityId: next.id,
          employeeId: actor.employeeId,
          payload: {
            color: next.color,
            sizeId: next.sizeId,
            limitQty: next.limitQty,
            consumedQty: next.consumedQty,
          },
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=cutReleasePolicy.disable policyId=${id} actor=${actor.employeeId}`,
    );
    return this.toDto(updated);
  }

  // -------------------------------------------------------------------------
  // helpers (используются внутри `PassportsService.issueToEmployee`)
  // -------------------------------------------------------------------------

  /**
   * Сформировать exception-сообщение из снимка политики. Помещаем
   * рядом с сервисом, потому что текст — это часть контракта политики
   * (формат «Сейчас разрешена выдача только: …, лимит N шт.»). Для
   * сборки текста используем shared-хелпер, чтобы UI и backend никогда
   * не разошлись. Лейбл размера получаем отдельным dictionary lookup
   * выше по стеку (мы не делаем join здесь, чтобы не тащить тяжёлый
   * include в issue-flow — там и так горячий путь).
   */
  buildViolation(input: {
    color: string | null;
    sizeLabel: string | null;
    limitQty: number;
  }): CutReleasePolicyViolationException {
    return new CutReleasePolicyViolationException(
      formatCutReleasePolicyMessage(input),
    );
  }

  // -------------------------------------------------------------------------
  // mapping
  // -------------------------------------------------------------------------

  private async toDto(
    row: Prisma.CutReleasePolicyGetPayload<true>,
  ): Promise<CutReleasePolicyDto> {
    let sizeLabel: string | null = null;
    if (row.sizeId) {
      const size = await this.prisma.size.findUnique({
        where: { id: row.sizeId },
        select: { code: true },
      });
      sizeLabel = size?.code ?? null;
    }
    return {
      id: row.id,
      isActive: row.isActive,
      color: row.color,
      sizeId: row.sizeId,
      sizeLabel,
      limitQty: row.limitQty,
      consumedQty: row.consumedQty,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
