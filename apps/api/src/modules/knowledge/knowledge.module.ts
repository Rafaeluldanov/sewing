import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';

/**
 * Модуль «База знаний» — редактируемая справка компании.
 *
 * Контракт — `knowledge.controller.ts`, UI — `apps/web/app/admin/knowledge`.
 * Сервис экспортируется: следующим этапом его `search()` зовёт
 * инструмент ассистента `docs.lookup`, чтобы поиск по статьям компании и
 * по системной справке был ОДИН, а не два разных.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
