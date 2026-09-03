/**
 * Черновики раскладов формы раскроя (`apps/web/app/cutter/[id]/cutting-form.tsx`)
 * и их слияние с серверными данными.
 *
 * Зачем отдельным модулем. Форма держит расклады в локальном стейте — в
 * него набивают «на настиле» и слои, — а сервер после каждого действия
 * присылает свою версию (`router.refresh()`). Раньше стейт брался из
 * пропсов ОДИН раз при монтировании и дальше жил своей жизнью; на этом
 * рассинхроне 10.08.2026 на прод-заказе 02-00013 настил сначала стёрся,
 * потом задублировался:
 *
 *   - «Открыть расклад» вернул расклад в работу, но форма продолжала
 *     считать его закрытым. Закрытые расклады в payload не уходят
 *     (`CUTTING_LAY_LOCKED`), и первое же «Сохранить» отправило пустой
 *     список — backend понял это как «расклад удалили» и снёс 6 размеров
 *     с 15 рулонами;
 *   - только что созданный расклад так и остался без `ordinal` (номер
 *     выдаёт backend), поэтому «Раскрой завершён» через 9 секунд после
 *     «Расклад готов» завёл ВТОРОЙ расклад — побайтовую копию первого.
 *
 * Правила слияния описаны в `mergeServerLays`. Логика чистая и покрыта
 * `tests/unit/cutting-lay-drafts.test.ts`.
 */
import type { CuttingTaskLayDto } from '@sewing/shared/cutting-tasks';

export interface RollDraft {
  /** Локальный ключ для React (стабилен при добавлении/удалении). */
  key: string;
  ordinal: number;
  layers: string;
  /** Ф3 «Расцветки»: id расцветки рулона (`OrderVariant`) или `null`. */
  variantId: string | null;
  /** Рулон ERP (серия склада ERP), с которого настилали, или `null`. */
  erpSeriesId: string | null;
  /** Подпись рулона на момент выбора: докроенный рулон уходит из остатка, подпись остаётся. */
  erpRollLabel: string | null;
}

export interface LayDraft {
  key: string;
  /**
   * Номер расклада на сервере (`CuttingTaskLay.ordinal`). `null` — расклад
   * ещё не сохранён (создан кнопкой «+ Добавить расклад»), номер выдаст
   * backend.
   *
   * Обязателен в payload для существующих раскладов: сохранение — merge по
   * `ordinal`, а не replace. Без него каждое сохранение заводило бы копию
   * расклада, а `Passport.cuttingLayOrdinal` выпущенных паспортов указывал
   * бы на чужой настил.
   */
  ordinal: number | null;
  /** Частичное завершение: момент «Расклад готов» (ISO) или `null`. */
  completedAt: string | null;
  /** Кто закрыл расклад — подпись в шапке закрытого расклада. */
  completedByName: string | null;
  /** Сколько паспортов по раскладу уже выпущено / ожидается. */
  releasedPassports: number;
  totalPassports: number;
  /** Сколько паспортов будет удалено при открытии расклада (см. DTO). */
  reopenDeletesPassports: number;
  /** Номера паспортов, уже ушедших в работу — они запирают расклад. */
  reopenBlockedPassports: string[];
  reopenBlockedTotal: number;
  /** Выбранные размеры: `sizeId → perLayerQty` строкой. Наличие = выбран. */
  sizes: Record<string, string>;
  rolls: RollDraft[];
}

/**
 * Поля нового (ещё не сохранённого) расклада: номера нет — его выдаст
 * backend при первом сохранении (append-only, max+1); закрытым он,
 * очевидно, тоже быть не может.
 */
export const NEW_LAY_META = {
  ordinal: null,
  completedAt: null,
  completedByName: null,
  releasedPassports: 0,
  totalPassports: 0,
  reopenDeletesPassports: 0,
  reopenBlockedPassports: [] as string[],
  reopenBlockedTotal: 0,
} as const;

export function layFromDto(dto: CuttingTaskLayDto): LayDraft {
  const sizes: Record<string, string> = {};
  for (const s of dto.sizes) {
    if (s.sizeId) sizes[s.sizeId] = s.perLayerQty === 0 ? '' : String(s.perLayerQty);
  }
  return {
    key: `lay-${dto.id}`,
    ordinal: dto.ordinal,
    completedAt: dto.completedAt,
    completedByName: dto.completedByName,
    releasedPassports: dto.releasedPassports,
    totalPassports: dto.totalPassports,
    reopenDeletesPassports: dto.reopenDeletesPassports,
    reopenBlockedPassports: dto.reopenBlockedPassports,
    reopenBlockedTotal: dto.reopenBlockedTotal,
    sizes,
    rolls: dto.rolls.map((r) => ({
      key: `roll-${r.id}`,
      ordinal: r.ordinal,
      layers: r.layers === 0 ? '' : String(r.layers),
      variantId: r.variantId,
      erpSeriesId: r.erpSeriesId ?? null,
      erpRollLabel: r.erpRollLabel ?? null,
    })),
  };
}

/**
 * Подпись серверных раскладов — по её изменению форма пересобирает свои
 * черновики. Берём всё, что меняет поведение экрана: состав раскладов,
 * их номера, закрытость и счётчики паспортов (от них зависят кнопки
 * «Расклад готов» / «Открыть расклад» и текст подтверждения).
 */
export function laysSignature(lays: CuttingTaskLayDto[]): string {
  return lays
    .map((l) =>
      [
        l.id,
        l.ordinal,
        l.completedAt ?? '',
        l.releasedPassports,
        l.totalPassports,
        l.reopenDeletesPassports,
        l.reopenBlockedTotal,
      ].join(':'),
    )
    .join('|');
}

/**
 * Влить серверные расклады в черновики формы:
 *   - черновик с `ordinal` ищет свой расклад по номеру; расклада больше
 *     нет (удалён) → уходит и черновик;
 *   - черновик без `ordinal` (только что созданный «+ Добавить расклад»)
 *     подхватывает первый «ничей» серверный расклад — это его номер,
 *     выданный при сохранении. Иначе следующее сохранение завело бы
 *     копию: расклад без номера backend считает новым;
 *   - ЗАКРЫТЫЙ расклад берём с сервера целиком: он read-only, показывать
 *     надо ровно то, что в БД;
 *   - у ОТКРЫТОГО оставляем набранные цифры (их могли ещё не сохранить),
 *     но подтягиваем серверные номер/закрытость/счётчики паспортов;
 *   - серверные расклады, которым черновика не нашлось, добавляем в конец.
 */
export function mergeServerLays(
  drafts: LayDraft[],
  server: CuttingTaskLayDto[],
): LayDraft[] {
  const byOrdinal = new Map(server.map((l) => [l.ordinal, l]));
  const claimed = new Set(
    drafts.filter((d) => d.ordinal != null).map((d) => d.ordinal as number),
  );
  const unclaimed = server.filter((l) => !claimed.has(l.ordinal));
  const next: LayDraft[] = [];
  for (const d of drafts) {
    if (d.ordinal == null) {
      const adopted = unclaimed.shift();
      next.push(adopted ? adoptServerLay(d, adopted) : d);
      continue;
    }
    const s = byOrdinal.get(d.ordinal);
    if (s) next.push(adoptServerLay(d, s));
  }
  for (const s of unclaimed) next.push(layFromDto(s));
  return next;
}

function adoptServerLay(draft: LayDraft, server: CuttingTaskLayDto): LayDraft {
  if (server.completedAt) return { ...layFromDto(server), key: draft.key };
  return {
    ...draft,
    ordinal: server.ordinal,
    completedAt: null,
    completedByName: null,
    releasedPassports: server.releasedPassports,
    totalPassports: server.totalPassports,
    reopenDeletesPassports: server.reopenDeletesPassports,
    reopenBlockedPassports: server.reopenBlockedPassports,
    reopenBlockedTotal: server.reopenBlockedTotal,
  };
}
