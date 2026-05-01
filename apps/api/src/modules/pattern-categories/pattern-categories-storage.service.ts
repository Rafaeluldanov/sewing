import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { PatternUploadInvalidException } from '../../common/errors.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * Локальный файловый storage для иконок категорий номенклатуры
 * (этап «Загружаемая иконка категории JPG/PNG», см.
 * `prisma/schema.prisma::PatternCategory.iconImageUrl`,
 * `apps/api/src/modules/pattern-categories/pattern-categories.controller.ts`,
 * `apps/web/app/admin/pattern-categories/new/*`).
 *
 * Сознательно сделан как отдельный сервис от
 * `PatternsStorageService`, чтобы:
 *   - whitelist расширений (JPG/JPEG/PNG) и лимит размера были
 *     независимы от лимитов лекал;
 *   - модуль `pattern-categories` оставался самодостаточным и не
 *     зависел от `PatternsModule`;
 *   - на проде директория `<uploadsRoot>/pattern-categories/...`
 *     могла бэкапиться отдельно от тяжёлых DXF-файлов.
 *
 * Корень storage берётся из `PATTERNS_UPLOADS_DIR` (env), по умолчанию
 * `apps/api/uploads` относительно `process.cwd()` — тот же, что у
 * `PatternsStorageService`. Раздача статики — через
 * `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`.
 *
 * Защиты от path-traversal / небезопасных имён — те же, что в
 * `PatternsStorageService` (см. ADR-style комментарий там); код
 * сделан копией, потому что MVP-связь между сервисами хочется
 * держать минимальной — обобщать преждевременно.
 */
@Injectable()
export class PatternCategoriesStorageService {
  private readonly logger = new Logger(PatternCategoriesStorageService.name);

  /**
   * Допустимые расширения иконки категории — растровые форматы
   * `jpg`/`jpeg`/`png`. SVG/WEBP сознательно НЕ принимаем:
   *   - SVG — исключаем риск SVG-инъекций (XSS через inline <script/>
   *     и внешние ссылки);
   *   - WEBP — не нужен для целей UI (одинаковая иконка 32–48px),
   *     добавим, если появится явный запрос.
   * Расширения нормализуем при сохранении (см. `pickStoredExtension`):
   *   `jpeg` → `.jpg`, `png` → `.png`.
   */
  static readonly ALLOWED_ICON_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const;

  /**
   * Лимит размера иконки категории — 5 МБ. Иконка маленькая
   * (24–28px в UI), так что лимит на порядок меньше дефолтного
   * лимита лекал (50 МБ DXF). Пользователю приходит понятная ошибка
   * заранее, до записи на диск.
   */
  static readonly ICON_MAX_SIZE_BYTES = 5 * 1024 * 1024;

  readonly uploadsRoot: string = resolve(
    process.env.PATTERNS_UPLOADS_DIR ?? join(process.cwd(), 'apps/api/uploads'),
  );
  readonly publicPrefix = '/uploads';

  /**
   * Сохранить иконку категории. Возвращает публичный URL для записи в
   * `PatternCategory.iconImageUrl` и оригинальное имя файла, которое
   * пишется в `PatternCategory.iconOriginalFileName`.
   *
   * Сценарий: один файл на категорию. На замене иконки старый файл
   * физически НЕ удаляется (как и в storage лекал — мы не делаем
   * destructive-операции с диском на MVP). На диске может остаться
   * «висящий» файл предыдущей версии — это сознательная упрощёнка:
   * место на диске небольшое, а возможность отката полезна.
   */
  async saveIcon(
    categoryId: string,
    file: UploadedFileLike,
  ): Promise<{ publicUrl: string; storedFileName: string; originalFileName: string }> {
    const safeOriginal = this.normalizeOriginalName(file.originalname);
    const ext = this.assertExtension(
      safeOriginal,
      PatternCategoriesStorageService.ALLOWED_ICON_EXTENSIONS,
    );
    this.assertSize(file);
    // На диске нормализуем расширение: `.jpeg` → `.jpg`, а `.png`
    // оставляем `.png`. Это сохраняет изначальный формат в URL —
    // статика отдаёт файл по расширению, и браузер сам определяет
    // правильный content-type. JPG и PNG не взаимозаменяемы по
    // bytes, поэтому хранить оба под `.jpg` нельзя.
    const storedFileName = this.makeStoredFileName(
      this.pickStoredExtension(ext),
    );
    const relativePath = posix.join(
      'pattern-categories',
      categoryId,
      'icon',
      storedFileName,
    );
    await this.writeFile(relativePath, file.buffer);
    this.logger.log(
      `event=pattern_category.icon_save categoryId=${categoryId} ext=${ext} bytes=${file.size}`,
    );
    return {
      publicUrl: `${this.publicPrefix}/${relativePath}`,
      storedFileName,
      originalFileName: safeOriginal,
    };
  }

  // -------------------------------------------------------------------------
  // INTERNAL — те же helper-ы, что в PatternsStorageService.
  // -------------------------------------------------------------------------

  private makeStoredFileName(ext: string): string {
    const timestamp = Date.now();
    const random = randomBytes(8).toString('hex');
    return `${timestamp}-${random}.${ext}`;
  }

  /**
   * Нормализация расширения для имени файла на диске.
   * `jpeg` → `jpg` (визуально аккуратнее в URL), `png` → `png`.
   * Любые будущие добавки (например, `webp`) тоже регистрируем здесь.
   */
  private pickStoredExtension(ext: string): string {
    if (ext === 'jpeg' || ext === 'jpg') return 'jpg';
    if (ext === 'png') return 'png';
    return ext;
  }

  private normalizeOriginalName(raw: string | undefined): string {
    if (!raw) {
      throw new PatternUploadInvalidException(
        'У файла нет имени — выберите его заново и повторите попытку.',
      );
    }
    const basename = raw.split(/[/\\]/).pop() ?? raw;
    const trimmed = basename.trim();
    if (trimmed.length === 0) {
      throw new PatternUploadInvalidException(
        'Имя файла пустое — переименуйте файл и повторите попытку.',
      );
    }
    if (trimmed.length > 255) {
      throw new PatternUploadInvalidException(
        'Имя файла слишком длинное (более 255 символов).',
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(trimmed)) {
      throw new PatternUploadInvalidException(
        'В имени файла недопустимые символы (control characters).',
      );
    }
    return trimmed;
  }

  private assertExtension(
    safeOriginal: string,
    allowed: readonly string[],
  ): string {
    const lastDot = safeOriginal.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === safeOriginal.length - 1) {
      throw new PatternUploadInvalidException(
        `У файла нет расширения (допустимо: ${allowed.join(', ')}).`,
      );
    }
    const ext = safeOriginal.slice(lastDot + 1).toLowerCase();
    if (!allowed.includes(ext)) {
      throw new PatternUploadInvalidException(
        `Недопустимое расширение «${ext}». Иконка категории — JPG, JPEG или PNG (${allowed.join(', ')}).`,
      );
    }
    return ext;
  }

  private assertSize(file: UploadedFileLike): void {
    if (file.size > PatternCategoriesStorageService.ICON_MAX_SIZE_BYTES) {
      const mb = Math.round(
        PatternCategoriesStorageService.ICON_MAX_SIZE_BYTES / 1024 / 1024,
      );
      throw new PatternUploadInvalidException(
        `Файл слишком большой: лимит ${mb} МБ.`,
      );
    }
  }

  private async writeFile(
    relativePath: string,
    buffer: Buffer,
  ): Promise<void> {
    const absolute = resolve(this.uploadsRoot, relativePath);
    if (
      !absolute.startsWith(this.uploadsRoot + '/') &&
      absolute !== this.uploadsRoot
    ) {
      this.logger.error(
        `Path traversal attempt suppressed: ${absolute} outside ${this.uploadsRoot}`,
      );
      throw new PatternUploadInvalidException('Недопустимый путь файла.');
    }
    await mkdir(absolute.slice(0, absolute.lastIndexOf('/')), {
      recursive: true,
    });
    await writeFile(absolute, buffer);
  }
}
