/**
 * Категория операции (`OperationCategory`) → подпись участка и класс
 * цвета. Один источник на весь фронт: раскраску участков показывают и
 * кабинет мастера (мини-лента, табель дня), и админский тайм-трекер —
 * экраны обязаны читаться как один инструмент, а не как два разных.
 *
 * Сами цвета — CSS-переменные `--u-*` в `globals.css`; палитра проверена
 * на различимость при дальтонизме, менять её на глаз нельзя.
 */

const CATEGORY_LABELS: Record<string, string> = {
  SEWING: 'Швейный',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
  CUTTING: 'Раскрой',
};

export function categoryClass(category: string): string {
  switch (category) {
    case 'SEWING':
      return 'is-sewing';
    case 'QC':
      return 'is-qc';
    case 'IRONING':
      return 'is-ironing';
    case 'PACKING':
      return 'is-packing';
    case 'CUTTING':
      return 'is-cutting';
    default:
      return 'is-other';
  }
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
