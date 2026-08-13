import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';

/**
 * Модуль «Ассистент» — окно диалога с ИИ в админке (этап 0: только
 * чтение). Полный дизайн — `docs/assistant.md`.
 *
 * Своих настроек модуль не заводит: они лежат в singleton-строке
 * `IntegrationSettings` рядом с настройками upgifts и правятся на той же
 * вкладке «Интеграции» (см. `IntegrationsService.update`).
 *
 * `PrismaService` и `AuditService` приезжают из глобальных модулей.
 * Ключ Anthropic сервис резолвит сам: платформенный из env
 * `ANTHROPIC_API_KEY` либо ключ компании из БД (шифрованный тем же
 * `secret-box.ts`, что и пароль upgifts).
 */
@Module({
  controllers: [AssistantController],
  providers: [AssistantService],
  exports: [AssistantService],
})
export class AssistantModule {}
