import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PushSubscribeDto } from './push.dto.js';

/**
 * Полезная нагрузка пуша. Service worker (`apps/web/public/sw.js`)
 * читает ровно эти поля, поэтому держим контракт узким и стабильным.
 */
export interface PushNotificationPayload {
  /** Тэг для дедупликации/перетирания на стороне ОС. */
  tag: string;
  title: string;
  body: string;
  /** Куда вести по клику (относительный путь в web-приложении). */
  url: string;
}

/**
 * Web Push (VAPID) — фоновые уведомления сотрудникам, работают даже
 * при свёрнутом приложении/потушенном экране (служба доставки браузера
 * будит service worker).
 *
 * Ключи VAPID берём из env (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`,
 * `VAPID_SUBJECT`). Если их нет — модуль входит в «disabled»-режим:
 * подписки всё равно сохраняются, но отправка молча пропускается с
 * единичным warning в логах. Это сознательно fail-soft: отсутствие
 * пуш-конфига не должно ломать ОТК-флоу `returnToRework`.
 *
 * Контракт доставки: `notifyEmployee` НИКОГДА не бросает — все ошибки
 * проглатываются/логируются, мёртвые подписки (404/410) удаляются.
 * Вызывающий код (`QcService`) дёргает её fire-and-forget после
 * коммита транзакции.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;
  private readonly publicKey: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.publicKey = config.get<string>('VAPID_PUBLIC_KEY') ?? '';
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY') ?? '';
    // `subject` обязателен для VAPID: mailto:/https:. Дефолт — APP_URL,
    // чтобы push-сервисы видели валидный контакт отправителя.
    const subject =
      config.get<string>('VAPID_SUBJECT') ??
      config.get<string>('APP_URL') ??
      'mailto:admin@example.com';

    this.enabled = Boolean(this.publicKey && privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(subject, this.publicKey, privateKey);
      this.logger.log('Web Push enabled (VAPID configured)');
    } else {
      this.logger.warn(
        'Web Push disabled: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — ' +
          'подписки сохраняются, но уведомления не отправляются.',
      );
    }
  }

  /** Публичный VAPID-ключ для клиентской подписки (`pushManager.subscribe`). */
  getPublicKey(): string {
    return this.publicKey;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Upsert подписки браузера. Ключ идемпотентности — `endpoint`
   * (глобально уникален). Повторная подписка того же браузера
   * обновляет ключи/владельца и `lastSeenAt`.
   */
  async saveSubscription(
    employeeId: string,
    dto: PushSubscribeDto,
    userAgent: string | null,
  ): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        employeeId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: userAgent ?? undefined,
      },
      update: {
        employeeId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: userAgent ?? undefined,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Снять подписку (logout / пользователь выключил уведомления). */
  async deleteSubscription(endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
  }

  /**
   * Разослать уведомление всем подпискам сотрудника. Никогда не бросает.
   * Мёртвые подписки (404/410 от службы доставки) удаляет.
   */
  async notifyEmployee(
    employeeId: string,
    payload: PushNotificationPayload,
  ): Promise<void> {
    if (!this.enabled) return;
    let subs: Array<{ endpoint: string; p256dh: string; auth: string }>;
    try {
      subs = await this.prisma.pushSubscription.findMany({
        where: { employeeId },
        select: { endpoint: true, p256dh: true, auth: true },
      });
    } catch (e) {
      this.logger.error(
        `notifyEmployee: не удалось прочитать подписки employeeId=${employeeId}: ${String(e)}`,
      );
      return;
    }
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    const stale: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            // urgency:high + TTL получаса: пуш о браке актуален недолго,
            // но должен пробиться сразу.
            { TTL: 1800, urgency: 'high' },
          );
        } catch (e) {
          const status = (e as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            stale.push(s.endpoint);
          } else {
            this.logger.warn(
              `push send failed (status=${status ?? '?'}) endpoint=${s.endpoint.slice(0, 48)}…`,
            );
          }
        }
      }),
    );

    if (stale.length > 0) {
      try {
        await this.prisma.pushSubscription.deleteMany({
          where: { endpoint: { in: stale } },
        });
        this.logger.log(`Удалено мёртвых push-подписок: ${stale.length}`);
      } catch {
        /* fail-soft: чистка — не критична */
      }
    }
  }
}
