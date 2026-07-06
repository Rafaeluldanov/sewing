/**
 * Рантайм-фиче-флаги веба (читаются server-side, не build-time
 * `NEXT_PUBLIC_*`).
 *
 * `FEATURE_COLORWAYS` — фича «Расцветки» (разные цвета для разных
 * размеров, у каждого цвета своя техкарта). Задумана как обратимый
 * прод-эксперимент: на проде OFF по умолчанию (включается
 * `FEATURE_COLORWAYS=1`), на dev — ON, чтобы можно было щупать.
 * Явное `FEATURE_COLORWAYS=0` выключает и на dev.
 */
export function isColorwaysEnabled(): boolean {
  const raw = process.env.FEATURE_COLORWAYS;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
