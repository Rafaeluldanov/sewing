'use client';

/**
 * `CreateMaterialIssueButton` — client-wrapper над
 * `CreateMaterialIssueDialog`. Нужен, чтобы серверный
 * `MaterialIssuesSection` мог показать кнопку «Создать расход» и
 * развернуть inline-форму без доп. роутинга и модальных окон.
 *
 * Отделён от диалога, потому что диалог сам использует
 * `useFormState` — собирать всё в одном client-компоненте можно, но
 * так `MaterialIssuesSection` проще: он передаёт сюда
 * `workshopNeeds` / `passports` как plain-JSON, а state «открыто /
 * свёрнуто» живёт локально.
 */
import { useState } from 'react';
import { PackagePlus } from 'lucide-react';
import type { PassportListItemDto } from '@sewing/shared/passports';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import { CreateMaterialIssueDialog } from './create-material-issue-dialog';

interface Props {
  orderId: string;
  workshopNeeds: WorkshopNeedListItemDto[];
  passports: PassportListItemDto[];
}

export function CreateMaterialIssueButton({
  orderId,
  workshopNeeds,
  passports,
}: Props) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <CreateMaterialIssueDialog
        orderId={orderId}
        workshopNeeds={workshopNeeds}
        passports={passports}
        onClose={() => setOpen(false)}
      />
    );
  }

  return (
    <button
      type="button"
      className="admin-btn admin-btn--primary"
      onClick={() => setOpen(true)}
      data-testid="create-material-issue-button"
    >
      <PackagePlus size={16} strokeWidth={1.6} aria-hidden />
      Создать расход
    </button>
  );
}
