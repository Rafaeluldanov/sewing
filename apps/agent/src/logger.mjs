/**
 * Минимальный stdout/stderr-логгер.
 *
 * Без сторонних библиотек: print-агент должен запускаться одной
 * командой на Windows-станции, любой `npm install` зависимости =
 * лишний риск отказа в проде.
 */

function stamp() {
  return new Date().toISOString();
}

function emit(stream, level, msg) {
  const line = `[${stamp()}] [${level.toUpperCase()}] ${msg}`;
  stream.write(line + '\n');
}

export const log = {
  info: (msg) => emit(process.stdout, 'info', msg),
  warn: (msg) => emit(process.stderr, 'warn', msg),
  error: (msg) => emit(process.stderr, 'error', msg),
};
