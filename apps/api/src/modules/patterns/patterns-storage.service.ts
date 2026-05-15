import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import {
  PATTERN_DXF_EXTENSIONS,
  PATTERN_FILE_MAX_SIZE_BYTES,
  PATTERN_PREVIEW_EXTENSIONS,
} from '@sewing/shared/patterns';
import { PatternUploadInvalidException } from '../../common/errors.js';

/**
 * Локальный файловый storage для модуля «Лекала» (MVP-1).
 *
 * Сознательные ограничения:
 *   - дисковое локальное хранилище, без S3/CDN. Раздача — через
 *     `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`.
 *   - файлы лежат в `<uploadsRoot>/patterns/<patternId>/{preview|sizes/<sizeId>}/<safeName>`;
 *   - имя файла генерируется как `${timestamp}-${randomHex}.${ext}` —
 *     menager не может предсказать URL (мини-защита от прямого
 *     перебора чужих файлов на multi-tenant сценариях, на MVP это
 *     просто гигиена);
 *   - валидация расширения и размера происходит на уровне сервиса
 *     ДО записи на диск — мы НЕ полагаемся на multer-фильтры
 *     (контроллер мог бы их забыть включить);
 *   - защита от path-traversal: `originalname` нормализуется до
 *     basename (`split(/[/\\]/).pop()`) и проходит regex; для имени
 *     на диске используется ТОЛЬКО сгенерированное безопасное имя;
 *   - DXF-файлы НЕ перезаписываются. Сервис лекал создаёт новую
 *     версию (`PatternSizeFile.version = max+1`), на диске тоже
 *     лежит отдельный файл.
 *
 * Корень storage берётся из `PATTERNS_UPLOADS_DIR` (env), по умолчанию
 * `apps/api/uploads` относительно `process.cwd()`. На stage/prod
 * каталог должен быть persisted (NFS / volume), иначе релиз снесёт
 * загрузки. См. `docs/recon-soft-integration.md`.
 */
@Injectable()
export class PatternsStorageService {
  private readonly logger = new Logger(PatternsStorageService.name);

  /**
   * Абсолютный путь к корню upload-каталога. `resolve` дополнительно
   * нормализует `..` — это важно как защита, если в env подсунули
   * относительный путь с переходом наверх.
   */
  readonly uploadsRoot: string = resolve(
    process.env.PATTERNS_UPLOADS_DIR ?? join(process.cwd(), 'apps/api/uploads'),
  );

  /**
   * Публичный URL-prefix, под которым `useStaticAssets` раздаёт
   * `uploadsRoot`. В БД мы пишем `${publicPrefix}/patterns/...` —
   * потребитель не привязан к физическому пути.
   */
  readonly publicPrefix = '/uploads';

  /**
   * Сохранить превью лекала. Возвращает публичный URL для записи в
   * `PatternItem.previewImageUrl`.
   */
  async savePreview(
    patternItemId: string,
    file: UploadedFileLike,
  ): Promise<{ publicUrl: string; storedFileName: string }> {
    const safeOriginal = this.normalizeOriginalName(file.originalname);
    const ext = this.assertExtension(safeOriginal, PATTERN_PREVIEW_EXTENSIONS);
    this.assertSize(file);
    const storedFileName = this.makeStoredFileName(ext);
    const relativePath = posix.join(
      'patterns',
      patternItemId,
      'preview',
      storedFileName,
    );
    await this.writeFile(relativePath, file.buffer);
    return {
      publicUrl: `${this.publicPrefix}/${relativePath}`,
      storedFileName,
    };
  }

  /**
   * Сохранить DXF лекала по конкретному размеру. Возвращает публичный
   * URL для записи в `PatternSizeFile.fileUrl`.
   *
   * НИКОГДА не перезаписывает существующий файл — даже если у нас
   * совпадёт случайная пара (timestamp + random), сервис лекал перед
   * вызовом уже резервирует новый `version`, и физическое имя файла
   * другое. См. `PatternsService.uploadSizeFile`.
   */
  async saveSizeFile(
    patternItemId: string,
    sizeId: string,
    file: UploadedFileLike,
  ): Promise<{ publicUrl: string; storedFileName: string }> {
    const safeOriginal = this.normalizeOriginalName(file.originalname);
    const ext = this.assertExtension(safeOriginal, PATTERN_DXF_EXTENSIONS);
    this.assertSize(file);
    const storedFileName = this.makeStoredFileName(ext);
    const relativePath = posix.join(
      'patterns',
      patternItemId,
      'sizes',
      sizeId,
      storedFileName,
    );
    await this.writeFile(relativePath, file.buffer);
    return {
      publicUrl: `${this.publicPrefix}/${relativePath}`,
      storedFileName,
    };
  }

  /**
   * Физически копирует существующий DXF-файл лекала в новую папку
   * под новой номенклатурой. Источник определяется по сохранённому
   * `fileUrl` (вида `/uploads/patterns/<src>/sizes/<sizeId>/<storedName>`).
   *
   * Расширение и имя нового файла генерируются заново — это даёт
   * стабильное «безопасное» имя на диске, как и при `saveSizeFile`.
   * Если у исходного URL расширение нестандартное (не входит в
   * `PATTERN_DXF_EXTENSIONS`), бросаем `PatternUploadInvalidException`
   * — это сигнал, что в БД лежит запись, которую uploader пропустил
   * бы.
   *
   * Используется методом `PatternsService.clone` при создании новой
   * номенклатуры по готовому лекалу. Физическое копирование (а не
   * shared `storageKey`) гарантирует, что архивация / удаление одной
   * номенклатуры не задевает другую.
   */
  async copySizeFile(
    sourceFileUrl: string,
    targetPatternId: string,
    targetSizeId: string,
  ): Promise<{ publicUrl: string; storedFileName: string }> {
    const sourceRel = this.publicUrlToRelative(sourceFileUrl);
    const sourceAbs = resolve(this.uploadsRoot, sourceRel);
    if (
      !sourceAbs.startsWith(this.uploadsRoot + '/') &&
      sourceAbs !== this.uploadsRoot
    ) {
      this.logger.error(
        `Path traversal attempt suppressed (source): ${sourceAbs} outside ${this.uploadsRoot}`,
      );
      throw new PatternUploadInvalidException('Недопустимый исходный путь файла.');
    }

    const sourceBasename = sourceRel.split('/').pop() ?? '';
    const lastDot = sourceBasename.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === sourceBasename.length - 1) {
      throw new PatternUploadInvalidException(
        'У исходного файла нет расширения — клонирование невозможно.',
      );
    }
    const ext = sourceBasename.slice(lastDot + 1).toLowerCase();
    if (!(PATTERN_DXF_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new PatternUploadInvalidException(
        `Недопустимое расширение «${ext}» у исходного DXF. Разрешены: ${PATTERN_DXF_EXTENSIONS.join(', ')}.`,
      );
    }

    const storedFileName = this.makeStoredFileName(ext);
    const targetRel = posix.join(
      'patterns',
      targetPatternId,
      'sizes',
      targetSizeId,
      storedFileName,
    );
    const targetAbs = resolve(this.uploadsRoot, targetRel);
    if (
      !targetAbs.startsWith(this.uploadsRoot + '/') &&
      targetAbs !== this.uploadsRoot
    ) {
      this.logger.error(
        `Path traversal attempt suppressed (target): ${targetAbs} outside ${this.uploadsRoot}`,
      );
      throw new PatternUploadInvalidException('Недопустимый путь нового файла.');
    }
    await mkdir(targetAbs.slice(0, targetAbs.lastIndexOf('/')), {
      recursive: true,
    });
    await copyFile(sourceAbs, targetAbs);
    return {
      publicUrl: `${this.publicPrefix}/${targetRel}`,
      storedFileName,
    };
  }

  /**
   * Превращает публичный URL (`/uploads/patterns/...`) в относительный
   * путь от `uploadsRoot`. Защищается от попыток подсунуть абсолютный
   * URL или URL вне `publicPrefix` — такие записи в БД у нас не
   * появляются нормальным flow, и `copySizeFile` правомерно их
   * отвергает.
   */
  private publicUrlToRelative(publicUrl: string): string {
    const prefix = `${this.publicPrefix}/`;
    if (!publicUrl.startsWith(prefix)) {
      throw new PatternUploadInvalidException(
        'Исходный файл хранится вне локального каталога — клонирование невозможно.',
      );
    }
    const rel = publicUrl.slice(prefix.length);
    if (rel.includes('..')) {
      throw new PatternUploadInvalidException('Недопустимый путь исходного файла.');
    }
    return rel;
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Безопасное имя файла на диске: `<unix-ms>-<8 hex bytes>.<ext>`.
   * Не зависит от `originalname` пользователя — это и есть защита от
   * path-traversal на уровне физического имени.
   */
  private makeStoredFileName(ext: string): string {
    const timestamp = Date.now();
    const random = randomBytes(8).toString('hex');
    return `${timestamp}-${random}.${ext}`;
  }

  /**
   * Нормализация `originalname`:
   *   - берём только basename (пути-разделители убираются);
   *   - триммим пробелы;
   *   - режем экстремально длинные имена (>255 для файла + страховка);
   *   - проверяем на запрещённые символы (контрольные, NUL).
   *
   * Возвращает «чистое» имя; используется ТОЛЬКО как
   * `PatternSizeFile.originalFileName` (показ пользователю /
   * скачивание с понятным именем). На диск всё равно пишется
   * сгенерированное `storedFileName`.
   */
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

  /**
   * Извлекает расширение из «чистого» имени файла и проверяет, что оно
   * входит в whitelist. Расширение возвращается lower-case (без
   * ведущей точки), чтобы physical filename был детерминирован.
   */
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
        `Недопустимое расширение «${ext}». Разрешены: ${allowed.join(', ')}.`,
      );
    }
    return ext;
  }

  private assertSize(file: UploadedFileLike): void {
    if (file.size > PATTERN_FILE_MAX_SIZE_BYTES) {
      const mb = Math.round(PATTERN_FILE_MAX_SIZE_BYTES / 1024 / 1024);
      throw new PatternUploadInvalidException(
        `Файл слишком большой: лимит ${mb} МБ.`,
      );
    }
  }

  /**
   * Запись файла на диск с предварительным `mkdir -p` для каталога.
   * `relativePath` всегда формируется этим сервисом из константных
   * сегментов и санитизированных id-шников Prisma — внешний вход в
   * этот метод исключён.
   */
  private async writeFile(
    relativePath: string,
    buffer: Buffer,
  ): Promise<void> {
    const absolute = resolve(this.uploadsRoot, relativePath);
    // Дополнительная страховка: финальный путь обязан лежать внутри
    // uploadsRoot. Если кто-то однажды решит протащить
    // user-controlled-сегмент в `relativePath` — здесь сломается явно,
    // а не молча запишется куда-нибудь рядом.
    if (!absolute.startsWith(this.uploadsRoot + '/') && absolute !== this.uploadsRoot) {
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

/**
 * Минимальный интерфейс upload-файла, ровно столько, сколько нам нужно
 * от `Express.Multer.File`. Использован самостоятельный type, чтобы
 * не тащить `@types/multer` в зависимости — `FileInterceptor` из
 * `@nestjs/platform-express` всё равно отдаёт совместимый объект.
 */
export interface UploadedFileLike {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
