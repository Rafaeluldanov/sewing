import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import {
  TECH_CARD_LINE_IMAGE_EXTENSIONS,
  TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES,
} from '@sewing/shared/tech-cards';
import { TechCardImageUploadInvalidException } from '../../common/errors.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * Локальный файловый storage для модуля «Техкарты» — секции
 * изображений строк материала (см. ТЗ §5, §9).
 *
 * Дизайн зеркалирует `PatternsStorageService` (тот же подход,
 * минимальные сюрпризы):
 *   - локальный файловый storage без S3/CDN; раздача — через
 *     `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`;
 *   - файлы лежат в
 *     `<uploadsRoot>/tech-cards/<techCardId>/materials/<lineId>/<safeName>`;
 *   - `safeName` = `${timestamp}-${randomHex}.${ext}` — не зависит
 *     от пользовательского `originalname`, защита от path-traversal
 *     на уровне физического имени;
 *   - валидация расширения и размера происходит на уровне сервиса
 *     ДО записи на диск — контроллер не обязан настраивать
 *     multer-фильтры;
 *   - upload НЕ перезаписывает старый файл: каждый upload — новый
 *     `storedFileName`; БД хранит публичный URL последнего
 *     загруженного файла, старые остаются на диске (фоновый GC
 *     отложен; см. `PatternsStorageService` — то же соглашение).
 *
 * Корень storage реиспользует `PATTERNS_UPLOADS_DIR` (env). На MVP
 * нет смысла плодить отдельный env под каждый модуль: оба пишут в
 * `apps/api/uploads` и раздаются единым префиксом `/uploads`.
 */
@Injectable()
export class TechCardsStorageService {
  private readonly logger = new Logger(TechCardsStorageService.name);

  /**
   * Абсолютный путь к корню upload-каталога. Совпадает с
   * `PatternsStorageService.uploadsRoot` — оба сервиса пишут в
   * один и тот же `apps/api/uploads`, иначе `useStaticAssets`
   * пришлось бы настраивать два разных префикса.
   */
  readonly uploadsRoot: string = resolve(
    process.env.PATTERNS_UPLOADS_DIR ?? join(process.cwd(), 'apps/api/uploads'),
  );

  readonly publicPrefix = '/uploads';

  /**
   * Сохранить изображение строки материала техкарты. Возвращает
   * публичный URL для записи в `TechCardMaterialLine.materialImageUrl`
   * и оригинальное имя файла (для записи в
   * `TechCardMaterialLine.materialImageOriginalFileName` — это видит
   * менеджер на превью).
   */
  async saveMaterialImage(
    techCardId: string,
    lineId: string,
    file: UploadedFileLike,
  ): Promise<{
    publicUrl: string;
    storedFileName: string;
    originalFileName: string;
  }> {
    const safeOriginal = this.normalizeOriginalName(file.originalname);
    const ext = this.assertExtension(
      safeOriginal,
      TECH_CARD_LINE_IMAGE_EXTENSIONS,
    );
    this.assertSize(file);
    const storedFileName = this.makeStoredFileName(ext);
    const relativePath = posix.join(
      'tech-cards',
      techCardId,
      'materials',
      lineId,
      storedFileName,
    );
    await this.writeFile(relativePath, file.buffer);
    return {
      publicUrl: `${this.publicPrefix}/${relativePath}`,
      storedFileName,
      originalFileName: safeOriginal,
    };
  }

  // -------------------------------------------------------------------------
  // INTERNAL — те же helpers, что в PatternsStorageService. Сознательно
  // дублируем: код короткий, общее наследование/абстракция здесь
  // привнесла бы больше связи между модулями, чем избавила бы от
  // дублирования.
  // -------------------------------------------------------------------------

  private makeStoredFileName(ext: string): string {
    const timestamp = Date.now();
    const random = randomBytes(8).toString('hex');
    return `${timestamp}-${random}.${ext}`;
  }

  private normalizeOriginalName(raw: string | undefined): string {
    if (!raw) {
      throw new TechCardImageUploadInvalidException(
        'У файла нет имени — выберите его заново и повторите попытку.',
      );
    }
    const basename = raw.split(/[/\\]/).pop() ?? raw;
    const trimmed = basename.trim();
    if (trimmed.length === 0) {
      throw new TechCardImageUploadInvalidException(
        'Имя файла пустое — переименуйте файл и повторите попытку.',
      );
    }
    if (trimmed.length > 255) {
      throw new TechCardImageUploadInvalidException(
        'Имя файла слишком длинное (более 255 символов).',
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(trimmed)) {
      throw new TechCardImageUploadInvalidException(
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
      throw new TechCardImageUploadInvalidException(
        `У файла нет расширения (допустимо: ${allowed.join(', ')}).`,
      );
    }
    const ext = safeOriginal.slice(lastDot + 1).toLowerCase();
    if (!allowed.includes(ext)) {
      throw new TechCardImageUploadInvalidException(
        `Недопустимое расширение «${ext}». Разрешены: ${allowed.join(', ')}.`,
      );
    }
    return ext;
  }

  private assertSize(file: UploadedFileLike): void {
    if (file.size > TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES) {
      const mb = Math.round(TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES / 1024 / 1024);
      throw new TechCardImageUploadInvalidException(
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
      throw new TechCardImageUploadInvalidException('Недопустимый путь файла.');
    }
    await mkdir(absolute.slice(0, absolute.lastIndexOf('/')), {
      recursive: true,
    });
    await writeFile(absolute, buffer);
  }
}
