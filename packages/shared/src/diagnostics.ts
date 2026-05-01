/**
 * Diagnostic consistency report — read-only DTO (см.
 * `docs/ops.md §«Diagnostics»`, `docs/domain.md §«Diagnostic
 * consistency report»`).
 *
 * Контракт:
 *   - `GET /api/admin/diagnostics/consistency` (роли `ADMIN`,
 *     `SHOP_MANAGER`);
 *   - сервер делает только `findMany`/`groupBy`/`count` — ничего не
 *     пишет в БД и ничего не «чинит» автоматически;
 *   - возвращает обзор «невозможных» состояний, которые менеджер
 *     должен разобрать руками.
 *
 * Никаких enum-ов и Zod-схем сознательно не вводим: severity
 * `CRITICAL`/`WARNING` — это единственная ось, а `code` остаётся
 * свободной строкой, чтобы добавить новый тип проверки без миграции
 * shared-контракта.
 */

export type DiagnosticSeverity = 'CRITICAL' | 'WARNING';

export interface DiagnosticIssueDto {
  /**
   * Машинно-читаемый код проверки (например,
   * `PASSPORT_IN_PROGRESS_WITHOUT_EMPLOYEE`). Стабильное значение —
   * UI и runbook ссылаются на него.
   */
  code: string;
  severity: DiagnosticSeverity;
  /**
   * Тип агрегата, к которому относится находка
   * (`PASSPORT`, `ORDER`, `SHIFT`, `EQUIPMENT`, `EMPLOYEE`,
   * `CELL_CONTENT`, `BOX`). Свободная строка — расширение списка
   * не требует миграции shared-контракта.
   */
  entityType: string;
  /** id основного агрегата (например, `Passport.id`). */
  entityId: string;
  /** Человекочитаемое объяснение (русский). */
  message: string;
  /**
   * Минимальный полезный JSON-срез: ключевые поля проверки (статус,
   * связанные id, qty). Сервис никогда не кладёт сюда полный
   * snapshot — только то, без чего находку нельзя осмыслить.
   */
  context: Record<string, unknown>;
}

export interface DiagnosticConsistencySummaryDto {
  total: number;
  critical: number;
  warning: number;
}

export interface DiagnosticConsistencyReportDto {
  /** Когда сервер сформировал отчёт (ISO). */
  generatedAt: string;
  summary: DiagnosticConsistencySummaryDto;
  /**
   * Набор находок. Сортировка стабильная: сначала `CRITICAL`, затем
   * `WARNING`, внутри — по `code` и `entityId`. Это гарантирует, что
   * UI и снапшот-тесты не моргают между прогонами.
   */
  issues: DiagnosticIssueDto[];
}
