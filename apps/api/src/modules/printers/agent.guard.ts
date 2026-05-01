import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { PrintersService } from './printers.service.js';

const AGENT_TOKEN_HEADER = 'x-printer-agent-token';
const AGENT_PRINTER_REQ_KEY = 'printerAgent';

/**
 * Простейший guard для агентских endpoint-ов
 * (`/api/print-jobs/agent`, `/api/printers/agent/heartbeat`).
 *
 * Агент аутентифицируется заголовком `X-Printer-Agent-Token`, выданным
 * при `pair`-е (см. `PrintersService.pairAgent`). Никаких сессий
 * Employee — это «принтер-станция», а не сотрудник.
 *
 * Не используется для `/api/printers/agent/pair`: тот endpoint
 * `@Public()`, так как клиент ещё не имеет токена.
 *
 * Контракт ответа на 401:
 *   { statusCode: 401, code: 'AGENT_UNAUTHENTICATED', message: '...' }
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly printers: PrintersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = req.headers?.[AGENT_TOKEN_HEADER];
    const token = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
    if (!token) throw new AgentUnauthorizedException();
    const printer = await this.printers.findByAgentToken(token);
    if (!printer) throw new AgentUnauthorizedException();
    if (!printer.isActive) throw new AgentUnauthorizedException();
    req[AGENT_PRINTER_REQ_KEY] = { id: printer.id, name: printer.name };
    return true;
  }
}

class AgentUnauthorizedException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: 401,
      code: 'AGENT_UNAUTHENTICATED',
      message: 'Неверный или просроченный токен агента принтера',
    });
  }
}

/**
 * Параметр-декоратор: достать `{ id, name }` принтера, прикреплённого
 * `AgentAuthGuard`-ом, к запросу.
 */
export const CurrentPrinter = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): { id: string; name: string } => {
    const req = ctx.switchToHttp().getRequest();
    const printer = req[AGENT_PRINTER_REQ_KEY] as
      | { id: string; name: string }
      | undefined;
    if (!printer) {
      throw new AgentUnauthorizedException();
    }
    return printer;
  },
);

export { AGENT_TOKEN_HEADER };
