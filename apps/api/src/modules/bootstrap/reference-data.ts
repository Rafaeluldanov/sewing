/**
 * Канонический справочник «системных» референс-данных, которые код
 * приложения трактует как константы:
 *
 *   - `Operation.code` — `CUT_DIVISION` обязателен в
 *     `PassportsService.create` (`OPERATION_NOT_FOUND`), `QC` / `WTO` /
 *     `PACKING` — для `QcTerminal` / `WtoTerminal` / `PackingTerminal`,
 *     `SEW_*` / `CUT_*` — для маршрутов оборудования и сдельных
 *     расчётов.
 *   - `Size.code` — стартовый набор детских/взрослых размеров. Ничего
 *     из кода жёстко не зависит, но без хотя бы одного размера нельзя
 *     ни создать заказ, ни выпустить паспорт; пустая таблица = тупик
 *     для пилотной инсталляции.
 *
 * Этот файл — единственный источник истины. Его читают:
 *
 *   1) `ReferenceDataBootstrapService` (см. `reference-data.service.ts`)
 *      на старте Nest — гарантирует, что строки существуют (создаёт
 *      только отсутствующие, существующие НЕ перезаписывает —
 *      менеджер в `/admin/operations` мог изменить `name`/
 *      `pricingMode`/`sortOrder`, и это не должно сноситься
 *      перезапуском контейнера).
 *
 *   2) `prisma/seed.ts` для dev/CI — там `upsert` с обновлением
 *      полей: на dev мы хотим воспроизводимость, и каждый re-seed
 *      возвращает справочники к каноническому состоянию из этого
 *      файла.
 *
 * Раньше эти константы лежали ТОЛЬКО в `prisma/seed.ts`, и в проде
 * (где seed не запускается) операции отсутствовали — UI падал на
 * `OPERATION_NOT_FOUND`. Подробнее — `docs/index.md §«Bootstrap
 * reference data»`.
 *
 * Категории (`OperationCategory`) и режимы pricing — плоские
 * строковые литералы, без зависимости от Prisma-enum. Это позволяет
 * импортировать файл и из NestJS-сервиса (рантайм с Prisma), и из
 * `prisma/seed.ts` (запускается через `tsx` без NestJS-контекста);
 * каждый потребитель приводит литералы к Prisma-типам у себя.
 */

export type ReferenceOperationCategory =
  | 'CUTTING'
  | 'SEWING'
  | 'QC'
  | 'IRONING'
  | 'PACKING';

export type ReferenceOperationPricingMode =
  | 'FIXED'
  | 'BY_SIZE'
  | 'SALARY_ONLY';

export type ReferenceOperationSeed = {
  code: string;
  name: string;
  category: ReferenceOperationCategory;
  sortOrder: number;
  pricingMode: ReferenceOperationPricingMode;
  /** Только для `FIXED`. Игнорируется иначе. */
  fixedRate?: number;
};

/**
 * Базовая бизнес-семантика (см. `docs/domain.md §16a`):
 *   - оверлок отличается по размеру → `BY_SIZE`;
 *   - остальные piecework (раскрой, киперка, распошив) — фиксированная
 *     ставка → `FIXED`;
 *   - подсобные/окладные операции (печать лекал, настил, ОТК, ВТО,
 *     упаковка и т.п.) — `SALARY_ONLY`, начисление не создаётся.
 *
 * Конкретные ставки специально консервативные демо-цифры: лежат в
 * допустимом диапазоне `Decimal(12,2)` и совпадают с adult-tier из
 * исторического `RATES_BY_OP`. Менеджер дальше правит их в
 * `/admin/operations`.
 */
export const REFERENCE_OPERATIONS: readonly ReferenceOperationSeed[] = [
  { code: 'CUT_PATTERN_PRINT', name: 'Печать лекал',      category: 'CUTTING', sortOrder: 10,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_SPREADING',     name: 'Настил',            category: 'CUTTING', sortOrder: 20,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_CUT',           name: 'Раскрой',           category: 'CUTTING', sortOrder: 30,  pricingMode: 'FIXED',    fixedRate: 12.0 },
  { code: 'CUT_DIVISION',      name: 'Деление кроя',      category: 'CUTTING', sortOrder: 40,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_BASE_PREP',     name: 'Подготовка основы', category: 'CUTTING', sortOrder: 50,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_RIBANA_PREP',   name: 'Подготовка рибаны', category: 'CUTTING', sortOrder: 60,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_ISSUE',         name: 'Выдача кроя',       category: 'SEWING',  sortOrder: 70,  pricingMode: 'SALARY_ONLY' },
  { code: 'SEW_OVERLOCK_1',    name: 'Оверлок 1',         category: 'SEWING',  sortOrder: 80,  pricingMode: 'BY_SIZE' },
  { code: 'SEW_BINDING',       name: 'Киперка',           category: 'SEWING',  sortOrder: 90,  pricingMode: 'FIXED',    fixedRate: 9.0 },
  { code: 'SEW_OVERLOCK_2',    name: 'Оверлок 2',         category: 'SEWING',  sortOrder: 100, pricingMode: 'BY_SIZE' },
  { code: 'SEW_COVERSTITCH',   name: 'Распошив',          category: 'SEWING',  sortOrder: 110, pricingMode: 'FIXED',    fixedRate: 13.5 },
  { code: 'QC',                name: 'ОТК',               category: 'QC',      sortOrder: 120, pricingMode: 'SALARY_ONLY' },
  { code: 'WTO',               name: 'ВТО',               category: 'IRONING', sortOrder: 130, pricingMode: 'SALARY_ONLY' },
  { code: 'PACKING',           name: 'Упаковка',          category: 'PACKING', sortOrder: 140, pricingMode: 'SALARY_ONLY' },
];

/**
 * Стартовый набор размеров. Длина и порядок зеркалят MVP-каталог:
 * сначала детские (по росту в см), затем взрослые (буквы). `sortOrder`
 * вычисляется по позиции в массиве (`(i + 1) * 10`), чтобы у первого
 * размера было `sortOrder = 10` и менеджер мог дальше вставлять
 * промежуточные значения без коллизий.
 */
export const REFERENCE_SIZES: readonly string[] = [
  '104',
  '110',
  '116',
  '122',
  '128',
  '134',
  '140',
  '146',
  '152',
  '158',
  '164',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  '2XL',
  '3XL',
  '4XL',
  '5XL',
  '6XL',
];
