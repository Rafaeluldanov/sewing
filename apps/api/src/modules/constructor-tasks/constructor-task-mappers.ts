import type { ConstructorTaskSummaryDto } from '@sewing/shared/constructor-tasks';

/**
 * Pure-функция маппинга `ConstructorTask` (с обязательными relation-ами)
 * в `ConstructorTaskSummaryDto`. Вынесена из `ConstructorTasksService.toSummary`
 * (private), чтобы её могли переиспользовать модули, у которых задача
 * приходит как часть сложного include — `OrdersService.getOne` (через
 * `patternItem.constructorTask`) и `PatternsService.getOne`. Без этого
 * каждый сервис писал бы свой плоский return-объект, и поля бы
 * расходились с `ConstructorTaskSummaryDto`-контрактом.
 *
 * Тип input — структурно-минимальный: то, что фактически нужно прочитать.
 * Любой Prisma-include с теми же select/include подойдёт.
 */
export function mapConstructorTaskSummary(t: {
  id: string;
  patternItemId: string;
  status: string;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  /** Этап «Архив справочников». Опционально — не все include его тянут. */
  archivedAt?: Date | null;
  createdBy: { fullName: string } | null;
  assignedTo: { fullName: string } | null;
  _count: { files: number; sizeRows: number };
  patternItem?: { name: string; article: string } | null;
}): ConstructorTaskSummaryDto {
  return {
    id: t.id,
    patternItemId: t.patternItemId,
    patternName: t.patternItem?.name ?? '',
    patternArticle: t.patternItem?.article ?? '',
    status: t.status as ConstructorTaskSummaryDto['status'],
    comment: t.comment,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    submittedAt: t.submittedAt ? t.submittedAt.toISOString() : null,
    acceptedAt: t.acceptedAt ? t.acceptedAt.toISOString() : null,
    archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
    createdByName: t.createdBy?.fullName ?? null,
    assignedToName: t.assignedTo?.fullName ?? null,
    filesCount: t._count.files,
    sizeRowsCount: t._count.sizeRows,
  };
}
