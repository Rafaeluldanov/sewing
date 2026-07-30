import { Role } from '@prisma/client';

/**
 * Карта «помощник делит принтер с основной ролью».
 *
 * Зачем: на MVP принтер привязывается к одной `Role`, но в реальном
 * цехе помощник физически работает за тем же раскройным/швейным/
 * упаковочным столом, что и сама основная роль. Заводить отдельный
 * принтер на роль-помощника бессмысленно — печатают они на одно и
 * то же физическое устройство.
 *
 * Как используется: см. `PrintJobsService.resolvePrinter`. Если у
 * самой роли сотрудника нет привязанного принтера, перебираем
 * fallback-роли в порядке приоритета и берём первый активный.
 *
 * Семантика по ролям:
 *   - `CUTTER_ASSISTANT` → делит принтер с `CUTTER` (один раскройный
 *     стол, один паспортный принтер).
 *
 * Если для роли fallback-ов нет — `resolveCandidateRoles` возвращает
 * массив только из самой роли, и поведение совпадает со старым
 * (одно `findFirst` по `role=employee.role`).
 *
 * См. также:
 *   - `docs/domain.md §17` — модель принтеров и привязки;
 *   - `docs/cutter-assistant-passport-release-recon.md §«print fallback»`
 *     — мотивация именно для CUTTER_ASSISTANT.
 */
export const PRINTER_ROLE_FALLBACKS: Partial<Record<Role, readonly Role[]>> = {
  CUTTER_ASSISTANT: [Role.CUTTER],
};

/**
 * Список ролей-кандидатов для поиска принтера в порядке приоритета:
 * сначала «своя» роль сотрудника, затем fallback из
 * `PRINTER_ROLE_FALLBACKS`. Дубликаты не возможны по построению (мы
 * сами кладём `role` как первый элемент, а в карте — только чужие
 * роли), но `Array.from(new Set(...))` страхует на случай ошибки в
 * конфигурации карты.
 */
export function resolveCandidateRoles(
  // Роль СОТРУДНИКА — строка (`AppRole.code`), роли заводятся из
  // админки. Привязка принтера (`Printer.role`) осталась enum-ом, так
  // что на выходе по-прежнему `Role[]`: кастомная роль просто не
  // совпадёт ни с одним значением и даст пустой список кандидатов —
  // печать уйдёт в общий fallback (`PRINTER_NOT_CONFIGURED_FOR_ROLE`).
  role: string,
): readonly Role[] {
  const known = (Object.values(Role) as string[]).includes(role)
    ? [role as Role]
    : [];
  const fallbacks = PRINTER_ROLE_FALLBACKS[role as Role] ?? [];
  return Array.from(new Set<Role>([...known, ...fallbacks]));
}
