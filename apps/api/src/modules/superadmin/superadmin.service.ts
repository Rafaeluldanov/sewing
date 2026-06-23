import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FEATURE_MODULE_KEYS } from '@sewing/shared/auth';
import type {
  AddDomainDto,
  CreateTenantDto,
  CreateTenantResultDto,
  SetModuleDto,
  SetStatusDto,
  TenantSummaryDto,
} from '@sewing/shared/superadmin';
import { ControlPlaneService } from '../../prisma/control-plane.service.js';
import { TenantRegistry } from '../../prisma/tenant-registry.service.js';

const execFileAsync = promisify(execFile);

/**
 * Бизнес-логика панели супер-админа: CRUD реестра тенантов поверх
 * `ControlPlaneService`. Изменения статуса/доменов сбрасывают кэш резолва
 * (`TenantRegistry`) — тот же процесс, эффект сразу.
 */
@Injectable()
export class SuperadminService {
  private readonly logger = new Logger(SuperadminService.name);

  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly registry: TenantRegistry,
  ) {}

  async listTenants(): Promise<TenantSummaryDto[]> {
    const tenants = await this.controlPlane.client.tenant.findMany({
      include: { domains: true, modules: true, migration: true },
      orderBy: { createdAt: 'asc' },
    });
    return tenants.map((t) => this.toSummary(t));
  }

  async getTenant(id: string): Promise<TenantSummaryDto> {
    const t = await this.controlPlane.client.tenant.findUnique({
      where: { id },
      include: { domains: true, modules: true, migration: true },
    });
    if (!t) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Тенант не найден' });
    return this.toSummary(t);
  }

  async setModule(id: string, dto: SetModuleDto): Promise<TenantSummaryDto> {
    await this.ensureTenant(id);
    await this.controlPlane.client.tenantModule.upsert({
      where: { tenantId_moduleKey: { tenantId: id, moduleKey: dto.moduleKey } },
      create: { tenantId: id, moduleKey: dto.moduleKey, enabled: dto.enabled },
      update: { enabled: dto.enabled },
    });
    // Модули резолвятся из БД на каждый /auth/me — кэш сбрасывать не нужно.
    return this.getTenant(id);
  }

  async setStatus(id: string, dto: SetStatusDto): Promise<TenantSummaryDto> {
    await this.ensureTenant(id);
    await this.controlPlane.client.tenant.update({
      where: { id },
      data: { status: dto.status },
    });
    // Статус влияет на резолв по Host (кэшируется) — сбрасываем немедленно.
    this.registry.invalidateAll();
    return this.getTenant(id);
  }

  async addDomain(id: string, dto: AddDomainDto): Promise<TenantSummaryDto> {
    await this.ensureTenant(id);
    const existing = await this.controlPlane.client.tenantDomain.findUnique({
      where: { host: dto.host },
    });
    if (existing) {
      throw new ConflictException({
        code: 'DOMAIN_TAKEN',
        message: `Домен ${dto.host} уже привязан.`,
      });
    }
    await this.controlPlane.client.tenantDomain.create({
      data: { host: dto.host, tenantId: id, isPrimary: false },
    });
    this.registry.invalidateAll();
    return this.getTenant(id);
  }

  async removeDomain(id: string, domainId: string): Promise<TenantSummaryDto> {
    const domain = await this.controlPlane.client.tenantDomain.findUnique({
      where: { id: domainId },
    });
    if (!domain || domain.tenantId !== id) {
      throw new NotFoundException({ code: 'DOMAIN_NOT_FOUND', message: 'Домен не найден' });
    }
    await this.controlPlane.client.tenantDomain.delete({ where: { id: domainId } });
    this.registry.invalidateHost(domain.host);
    return this.getTenant(id);
  }

  /**
   * Провижининг нового тенанта: запускает проверенный скрипт
   * `scripts/tenants/create-tenant.ts` (CREATE DATABASE → migrate deploy →
   * сид → admin → регистрация). Синхронно, с таймаутом — операция редкая и
   * выполняется супер-админом осознанно.
   */
  async createTenant(dto: CreateTenantDto): Promise<CreateTenantResultDto> {
    // Корень репозитория детерминированно: в dev процесс стартует из
    // /app/apps/api, в prod — из /app. Ищем тот каталог, где реально лежит
    // скрипт (а не полагаемся на process.cwd()).
    const repoRoot = this.resolveRepoRoot();
    const script = path.join(repoRoot, 'scripts/tenants/create-tenant.ts');
    const args = [
      'tsx', script,
      '--slug', dto.slug,
      '--name', dto.name,
      '--db-name', dto.dbName,
      '--host', dto.host,
      '--admin-login', dto.adminLogin,
    ];
    if (dto.adminName) args.push('--admin-name', dto.adminName);
    try {
      const { stdout, stderr } = await execFileAsync('npx', args, {
        cwd: repoRoot,
        // Пароль админа — через env, НЕ в argv (argv виден в `ps`/proc, CWE-214).
        env: { ...process.env, TENANT_ADMIN_PASSWORD: dto.adminPassword },
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      this.registry.invalidateAll();
      this.logger.log(`event=superadmin.tenant.created slug=${dto.slug}`);
      return { ok: true, slug: dto.slug, log: tail(stdout + stderr) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      this.logger.warn(
        `event=superadmin.tenant.create_failed slug=${dto.slug}: ${e.message ?? ''}`,
      );
      return {
        ok: false,
        slug: dto.slug,
        log: tail(`${e.stdout ?? ''}${e.stderr ?? ''}\n${e.message ?? ''}`),
      };
    }
  }

  private async ensureTenant(id: string): Promise<void> {
    const t = await this.controlPlane.client.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Тенант не найден' });
  }

  /** Каталог, где лежит scripts/tenants (dev: /app/apps/api → ../.. ; prod: /app). */
  private resolveRepoRoot(): string {
    const rel = 'scripts/tenants/create-tenant.ts';
    const candidates = [
      process.cwd(),
      path.resolve(process.cwd(), '..', '..'),
      '/app',
    ];
    return candidates.find((r) => existsSync(path.join(r, rel))) ?? process.cwd();
  }

  private toSummary(t: {
    id: string;
    slug: string;
    name: string;
    status: string;
    dbUrl: string;
    createdAt: Date;
    domains: { id: string; host: string; isPrimary: boolean }[];
    modules: { moduleKey: string; enabled: boolean }[];
    migration: { lastMigration: string | null; lastStatus: string | null; updatedAt: Date } | null;
  }): TenantSummaryDto {
    const explicit = new Map(t.modules.map((m) => [m.moduleKey, m.enabled]));
    const modules = FEATURE_MODULE_KEYS.map((key) => ({
      moduleKey: key,
      enabled: explicit.has(key) ? Boolean(explicit.get(key)) : true,
      explicit: explicit.has(key),
    }));
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status as TenantSummaryDto['status'],
      createdAt: t.createdAt.toISOString(),
      dbName: safeDbName(t.dbUrl),
      domains: t.domains
        .map((d) => ({ id: d.id, host: d.host, isPrimary: d.isPrimary }))
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
      modules,
      migration: t.migration
        ? {
            lastMigration: t.migration.lastMigration,
            lastStatus: t.migration.lastStatus,
            updatedAt: t.migration.updatedAt.toISOString(),
          }
        : null,
    };
  }
}

function safeDbName(dbUrl: string): string {
  try {
    return new URL(dbUrl).pathname.replace(/^\//, '') || '—';
  } catch {
    return '—';
  }
}

function tail(s: string, max = 4000): string {
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(trimmed.length - max) : trimmed;
}
