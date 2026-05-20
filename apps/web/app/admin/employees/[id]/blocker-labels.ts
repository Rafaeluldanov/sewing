import type {
  EmployeeArchiveBlockerDto,
  EmployeeHardDeleteBlockerDto,
} from '@sewing/shared/employees';

/**
 * Человеческое описание блокера архивирования. Использует `count` из
 * DTO, чтобы оператор сразу видел масштаб. Локализация — ru-RU (другие
 * локали проекту пока не нужны).
 */
export function describeArchiveBlocker(
  b: EmployeeArchiveBlockerDto,
): string {
  switch (b.kind) {
    case 'OPEN_SHIFT':
      return 'У сотрудника открыта смена. Завершите смену через «⋯ → Завершить смену».';
    case 'CURRENT_PASSPORTS':
      return `На сотруднике висит ${b.count} ${pluralize(b.count, 'паспорт', 'паспорта', 'паспортов')} (currentEmployeeId). Передайте через мастер-маршрут.`;
    case 'OPEN_MASTER_CALLS':
      return `Открытые вызовы мастера: ${b.count}. Закройте или отмените их перед архивом.`;
    case 'OPEN_CLOSURE_REQUESTS':
      return `Заявок на закрытие раскроя со статусом REQUESTED: ${b.count}. Мастер должен их обработать.`;
    default:
      return `Неизвестный блокер: ${(b as { kind: string }).kind}`;
  }
}

/**
 * Человеческое описание блокера hard-delete. Цель — показать оператору,
 * почему запись нельзя удалить навсегда, и подтолкнуть к архивированию.
 */
export function describeHardDeleteBlocker(
  b: EmployeeHardDeleteBlockerDto,
): string {
  switch (b.kind) {
    case 'OperationEntry':
      return `Сдельных начислений: ${b.count}.`;
    case 'SalaryEntry':
      return `Окладных записей: ${b.count}.`;
    case 'Passport':
      return `Привязок к паспортам: ${b.count} (как раскройщик / создатель / текущий).`;
    case 'PassportDefect':
      return `Зафиксированных дефектов: ${b.count}.`;
    case 'ShiftSession':
      return `Смен в истории: ${b.count}.`;
    case 'Box':
      return `Собранных коробок: ${b.count}.`;
    case 'MasterCall':
      return `Связанных вызовов мастера: ${b.count}.`;
    case 'PayrollPayout':
      return `Выплат зарплаты: ${b.count}.`;
    case 'PayrollAccrualDocumentLine':
      return `Строк в документах начисления: ${b.count}.`;
    default:
      return `Неизвестный блокер: ${(b as { kind: string }).kind}.`;
  }
}

function pluralize(
  n: number,
  one: string,
  few: string,
  many: string,
): string {
  const pr = new Intl.PluralRules('ru-RU');
  const c = pr.select(n);
  if (c === 'one') return one;
  if (c === 'few') return few;
  return many;
}
