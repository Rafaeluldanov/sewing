#!/usr/bin/env node
/**
 * Подготовка тенанта к выставке: рабочие места под QR со схемы
 * `docs/mockups/sewing-shopfloor-steps.html`, экспо-сотрудники, сброс
 * зависших смен и самопроверка «скан со схемы → смена на этом месте».
 *
 * Идемпотентен — гонять перед выставкой и между показами:
 *
 *   node scripts/demo/expo-setup.mjs                       # demo2 через dev-API
 *   node scripts/demo/expo-setup.mjs --host demo2.localhost --api http://localhost:3001
 *   SEWING_ADMIN_PASSWORD=… node scripts/demo/expo-setup.mjs --host expo.localhost
 *
 * Что делает (всё через живой API, чтобы PIN писался штатно —
 * `pinHash`+`pinEnc`, см. `common/pin-columns.ts`; голый UPDATE в БД
 * оставит «Показать пароль» врущим):
 *   1. Оборудование: коды из схемы существуют, активны, у раскройного
 *      стола есть операция смены `CUT_CUT` (сид `EQUIPMENT` в
 *      `prisma/seed.ts` её не привязывает на старых тенантах).
 *   2. Сотрудники `expo*`: создать или привести к нужному состоянию
 *      (PIN, роли, active). `expo` — универсал со всеми цеховыми ролями:
 *      один телефон на стенде, «Сменить место» → скан блока → кабинет.
 *   3. Смены: закрыть зависшие смены экспо-сотрудников (паспорт на
 *      руках — предупреждение, смена закрывается принудительно).
 *   4. Самопроверка: за каждого сотрудника `POST /api/me/switch-workplace
 *      {code: 'equipment:<код>'}` — ровно то, что делает скан QR со
 *      схемы. Любой отказ печатается кодом ошибки.
 *
 * Пароли: `SEWING_ADMIN_LOGIN`/`SEWING_ADMIN_PASSWORD` (дефолт — сидовые
 * admin / Demo12345!), PIN экспо-учёток — `--pin` или `EXPO_PIN`
 * (дефолт Expo2026).
 */

const argv = parseArgs(process.argv.slice(2));
const API = (argv.api ?? process.env.SEWING_API ?? 'http://localhost:3001').replace(/\/$/, '');
const HOST = argv.host ?? process.env.SEWING_TENANT_HOST ?? 'demo2.localhost';
const PIN = argv.pin ?? process.env.EXPO_PIN ?? 'Expo2026';
const ADMIN_LOGIN = process.env.SEWING_ADMIN_LOGIN ?? 'admin';
const ADMIN_PASSWORD = process.env.SEWING_ADMIN_PASSWORD ?? 'Demo12345!';

/** Рабочие места со схемы: код оборудования → роль участка и операция смены. */
const WORKPLACES = [
  { code: 'cutting-table-01', role: 'CUTTER', shiftOp: 'CUT_CUT' },
  { code: 'overlock-01', role: 'SEAMSTRESS', shiftOp: 'SEW_OVERLOCK_1' },
  { code: 'qc-station-01', role: 'QC', shiftOp: 'QC' },
  { code: 'wto-station-01', role: 'IRONING', shiftOp: 'WTO' },
  { code: 'packing-station-01', role: 'PACKING', shiftOp: 'PACKING' },
];

const SHOPFLOOR_ROLES = ['SEAMSTRESS', 'CUTTER', 'QC', 'IRONING', 'PACKING'];

/** Экспо-учётки. MIXED + часовая ставка: на стенде видно и сдельщину, и оклад. */
const worker = (login, fullName, role, roles = [role]) => ({
  login,
  fullName,
  role,
  roles,
  compensationType: 'MIXED',
  salaryRateMode: 'HOURLY',
  salaryPerHour: 300,
});
const office = (login, fullName, role) => ({
  login,
  fullName,
  role,
  roles: [role],
  compensationType: 'SALARY',
  salaryRateMode: 'HOURLY',
  salaryPerHour: 400,
});
const EMPLOYEES = [
  worker('expo', 'Экспо Универсал', 'SEAMSTRESS', SHOPFLOOR_ROLES),
  worker('expo-cutter', 'Экспо Раскройщик', 'CUTTER'),
  worker('expo-seamstress', 'Экспо Швея', 'SEAMSTRESS'),
  worker('expo-qc', 'Экспо ОТК', 'QC'),
  worker('expo-wto', 'Экспо ВТО', 'IRONING'),
  worker('expo-packer', 'Экспо Упаковщик', 'PACKING'),
  office('expo-master', 'Экспо Мастер цеха', 'SHOPFLOOR_MASTER'),
  office('expo-manager', 'Экспо Менеджер', 'SHOP_MANAGER'),
];

const problems = [];
const log = (...a) => console.log(...a);
const warn = (msg) => {
  problems.push(msg);
  console.log(`  !! ${msg}`);
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function login(loginName, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-host': HOST },
    body: JSON.stringify({ login: loginName, password }),
  });
  if (!res.ok) {
    throw new Error(`login ${loginName}: HTTP ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /sewing_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error(`login ${loginName}: нет cookie sewing_session`);
  return `sewing_session=${m[1]}`;
}

async function call(cookie, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tenant-host': HOST,
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function errCode(r) {
  return r.json?.code ?? r.json?.error?.code ?? r.json?.message ?? `HTTP ${r.status}`;
}

// ---------------------------------------------------------------------------
// 1. Оборудование
// ---------------------------------------------------------------------------

async function ensureEquipment(admin) {
  log(`\n[1] Оборудование (${HOST})`);
  const list = await call(admin, 'GET', '/api/equipment');
  if (!list.ok) throw new Error(`GET /api/equipment: ${errCode(list)}`);
  const rows = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
  const byCode = new Map(rows.map((e) => [e.code, e]));

  const ops = await call(admin, 'GET', '/api/operations');
  if (!ops.ok) throw new Error(`GET /api/operations: ${errCode(ops)}`);
  const opByCode = new Map(ops.json.map((o) => [o.code, o]));

  for (const wp of WORKPLACES) {
    const eq = byCode.get(wp.code);
    if (!eq) {
      warn(`нет оборудования с кодом ${wp.code} — QR блока не распознается`);
      continue;
    }
    const detail = await call(admin, 'GET', `/api/equipment/${eq.id}`);
    if (!detail.ok) throw new Error(`GET /api/equipment/${eq.id}: ${errCode(detail)}`);
    const d = detail.json;
    const state = [];
    if (!d.active) warn(`${wp.code} неактивно — скан даст EQUIPMENT_INACTIVE`);
    if (d.role !== wp.role) {
      warn(`${wp.code}: роль участка ${d.role ?? '—'}, ожидалась ${wp.role} — «Сменить место» не сработает`);
    }
    const allowedIds = d.allowedOperations.map((l) => l.operationId);
    const hasShiftOp = d.allowedOperations.some((l) => l.operationCode === wp.shiftOp);
    if (!hasShiftOp) {
      const op = opByCode.get(wp.shiftOp);
      if (!op) {
        warn(`${wp.code}: в справочнике нет операции ${wp.shiftOp}`);
      } else {
        // операция смены — первой, чтобы форма старта её пред-выбирала
        const r = await call(admin, 'PATCH', `/api/equipment/${eq.id}/operations`, {
          operationIds: [op.id, ...allowedIds],
        });
        if (!r.ok) warn(`${wp.code}: не удалось добавить ${wp.shiftOp}: ${errCode(r)}`);
        else state.push(`+${wp.shiftOp}`);
      }
    }
    log(`  ${wp.code.padEnd(20)} ${d.name}  ${state.join(' ') || 'ok'}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Сотрудники
// ---------------------------------------------------------------------------

async function ensureEmployees(admin) {
  log(`\n[2] Экспо-сотрудники (PIN ${PIN})`);
  const list = await call(admin, 'GET', '/api/employees');
  if (!list.ok) throw new Error(`GET /api/employees: ${errCode(list)}`);
  const rows = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
  const byLogin = new Map(rows.map((e) => [e.login, e]));

  for (const spec of EMPLOYEES) {
    const existing = byLogin.get(spec.login);
    if (existing) {
      const r = await call(admin, 'PATCH', `/api/employees/${existing.id}`, {
        pin: PIN,
        role: spec.role,
        roles: spec.roles,
        active: true,
        compensationType: spec.compensationType,
        salaryRateMode: spec.salaryRateMode,
        salaryPerHour: spec.salaryPerHour,
      });
      if (!r.ok) warn(`${spec.login}: PATCH → ${errCode(r)}`);
      else log(`  ${spec.login.padEnd(16)} ${spec.fullName.padEnd(20)} обновлён  [${spec.roles.join(', ')}]`);
    } else {
      const r = await call(admin, 'POST', '/api/employees', { ...spec, pin: PIN, active: true });
      if (!r.ok) warn(`${spec.login}: POST → ${errCode(r)}`);
      else log(`  ${spec.login.padEnd(16)} ${spec.fullName.padEnd(20)} создан    [${spec.roles.join(', ')}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3–4. Смены и самопроверка скана
// ---------------------------------------------------------------------------

async function resetAndProbe() {
  log(`\n[3] Смены и самопроверка скана (equipment:<код> → switch-workplace)`);
  for (const spec of EMPLOYEES) {
    let cookie;
    try {
      cookie = await login(spec.login, PIN);
    } catch (e) {
      warn(`${spec.login}: не логинится — ${e.message}`);
      continue;
    }

    const cur = await call(cookie, 'GET', '/api/shifts/current');
    if (cur.ok && cur.json?.active) {
      const work = await call(cookie, 'GET', '/api/shifts/current-work');
      const held = Array.isArray(work.json) ? work.json.length : (work.json?.items?.length ?? 0);
      if (held > 0) warn(`${spec.login}: ${held} паспорт(ов) на руках — смена закрывается принудительно`);
      const stop = await call(cookie, 'POST', '/api/shifts/stop', {});
      if (!stop.ok) {
        // ShiftHasActivePassports и т.п. — закрываем через switch-workplace force ниже
        log(`  ${spec.login}: stop → ${errCode(stop)}, закрою переключением участка`);
      } else {
        log(`  ${spec.login}: зависшая смена закрыта`);
      }
    }

    const targets = WORKPLACES.filter((wp) => spec.roles.includes(wp.role));
    if (targets.length === 0) {
      log(`  ${spec.login.padEnd(16)} без цеховых участков — пропуск`);
      continue;
    }
    const results = [];
    for (const wp of targets) {
      const r = await call(cookie, 'POST', '/api/me/switch-workplace', {
        code: `equipment:${wp.code}`,
        force: true,
      });
      results.push(r.ok ? `${wp.code} ✓` : `${wp.code} ✗ ${errCode(r)}`);
      if (!r.ok) warn(`${spec.login} → ${wp.code}: ${errCode(r)}`);
    }
    // вернуть универсала на основную роль, чтобы /work открывался как у швеи
    if (spec.roles.length > 1) {
      await call(cookie, 'POST', '/api/me/switch-workplace', { role: spec.role, force: true });
    }
    log(`  ${spec.login.padEnd(16)} ${results.join('  ')}`);
  }
}

// ---------------------------------------------------------------------------

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const admin = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
log(`Тенант ${HOST} через ${API}, админ ${ADMIN_LOGIN}`);
await ensureEquipment(admin);
await ensureEmployees(admin);
await resetAndProbe();

if (problems.length) {
  log(`\nГотово с замечаниями (${problems.length}):`);
  for (const p of problems) log(`  - ${p}`);
  process.exitCode = 1;
} else {
  log('\nГотово: все QR со схемы открывают своё рабочее место.');
}
