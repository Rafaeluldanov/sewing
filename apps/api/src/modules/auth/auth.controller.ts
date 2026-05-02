import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  LoginRequestSchema,
  type LoginRequestDto,
  type LoginResponseDto,
  type MeResponseDto,
} from '@sewing/shared/auth';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { UnauthenticatedException } from '../../common/errors.js';
import { AuthService } from './auth.service.js';
import { CurrentUser, Public } from './auth.decorators.js';
import type { AuthPrincipal } from './auth.types.js';
import {
  parseCookieHeader,
  serializeClearCookie,
  serializeCookie,
  SESSION_COOKIE_NAME,
} from './cookie.js';

/**
 * Контракты — `docs/api.md §1 Auth`.
 *
 * Для login и logout сами выставляем заголовок `Set-Cookie`, чтобы не
 * тащить дополнительные зависимости (cookie-parser/express middleware).
 * `/me` доступен любому авторизованному пользователю; `/login` и
 * `/logout` — публичные точки входа/выхода (logout идемпотентен).
 */
@Controller('auth')
export class AuthController {
  // `@Inject(AuthService)` задан явно, потому что dev-раннер (`tsx watch`
  // через esbuild) не эмитит `design:paramtypes` — без явного декоратора
  // Nest DI не подставит AuthService, и `this.auth` окажется `undefined`
  // уже на `/api/auth/login`.
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) dto: LoginRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { user, cookie } = await this.auth.login(dto.login, dto.password);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(cookie.name, cookie.value, cookie.attrs),
    );
    return {
      user: {
        id: user.employeeId,
        login: user.login,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }

  /**
   * Logout — публичный и идемпотентный: даже если cookie уже истекла
   * или не передана, мы возвращаем 204 и затираем cookie на стороне
   * клиента. Это упрощает UI: «выйти» всегда работает.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    const { name, attrs } = this.auth.buildLogoutCookie();
    res.setHeader('Set-Cookie', serializeClearCookie(name, attrs));
  }

  @Get('me')
  me(@CurrentUser() principal: AuthPrincipal | undefined): MeResponseDto {
    if (!principal) throw new UnauthenticatedException();
    return {
      user: {
        id: principal.employeeId,
        login: principal.login,
        fullName: principal.fullName,
        role: principal.role,
      },
    };
  }
}

/**
 * Утилита: достаёт session-cookie из заголовков запроса. Вынесена
 * сюда (а не в guard) на случай переиспользования в SSR-прокси и
 * тестах. Возвращает `null`, если cookie нет или она пустая.
 */
export function readSessionCookie(headerCookie: string | undefined): string | null {
  const cookies = parseCookieHeader(headerCookie);
  const value = cookies[SESSION_COOKIE_NAME];
  return value && value.length > 0 ? value : null;
}
