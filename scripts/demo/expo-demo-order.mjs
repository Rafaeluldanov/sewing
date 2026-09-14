#!/usr/bin/env node
/**
 * Демо-заказ для стенда: создаёт заказ на выставочном тенанте и доводит его
 * до нужного шага схемы, чтобы дальше двигать руками (сканами с телефона).
 *
 *   node scripts/demo/expo-demo-order.mjs                  # до шага 4: крой сделан, паспорта лежат в ячейке
 *   node scripts/demo/expo-demo-order.mjs --stage sewing   # + шаг 5: швея взяла крой (как скан на стенде)
 *   node scripts/demo/expo-demo-order.mjs --pattern "Худи классический" --sizes M,L --qty 10 --color графит
 *
 * Что гарантирует (идемпотентно для справочников, заказ — каждый раз новый):
 *   - клиент «Стенд» и шаблон маршрута «Экспо: оверлок → ОТК → ВТО → упаковка»
 *     (без маршрута у паспорта нет снапшота шагов, и швея не сможет взять крой
 *     иначе как из ячейки; с маршрутом монитор рисует ▶/✔ по операциям);
 *   - заказ с одной расцветкой и размерами, «Запустить в производство»;
 *   - паспорта по размерам (начисление за раскрой — на `expo-cutter`) в ячейке;
 *     живой шаг 4 в /cutter (расклады → «Выпуск») скрипт не подменяет;
 *   - `--stage sewing`: `expo-seamstress` открывает смену на оверлоке и берёт
 *     крой — ровно то, что делает скан паспорта на шаге 5.
 *
 * В конце печатает ссылки: карточка заказа, этикетки паспортов (их и
 * сканируют на стенде — с распечатки или прямо с экрана ноутбука) и то, что
 * сейчас показывает монитор цеха по этапам.
 *
 * Пароли: SEWING_ADMIN_LOGIN / SEWING_ADMIN_PASSWORD (admin тенанта expo),
 * EXPO_PIN (учётки expo*, дефолт Expo2026). См. expo-setup.mjs.
 */

const argv = parseArgs(process.argv.slice(2));
const API = (argv.api ?? process.env.SEWING_API ?? 'https://expo.teeon.ru').replace(/\/$/, '');
const HOST = argv.host ?? process.env.SEWING_TENANT_HOST ?? 'expo.teeon.ru';
const PIN = process.env.EXPO_PIN ?? 'Expo2026';
const ADMIN_LOGIN = process.env.SEWING_ADMIN_LOGIN ?? 'admin';
const ADMIN_PASSWORD = process.env.SEWING_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Задайте SEWING_ADMIN_PASSWORD — пароль admin тенанта expo');
  process.exit(1);
}

const STAGE = argv.stage ?? 'cut';
if (!['cut', 'sewing'].includes(STAGE)) {
  console.error(`--stage: cut | sewing (получено ${STAGE})`);
  process.exit(1);
}
const PATTERN_NAME = argv.pattern ?? 'Футболка черная';
const SIZE_CODES = String(argv.sizes ?? 'M,L,XL').split(',').map((s) => s.trim()).filter(Boolean);
const QTY = Number(argv.qty ?? 12);
const COLOR = argv.color ?? 'чёрный';

const CLIENT_NAME = 'Стенд (выставка)';
const ROUTE_CODE = 'EXPO-01';
const ROUTE_NAME = 'Экспо: оверлок → ОТК → ВТО → упаковка';
const ROUTE_OPS = ['SEW_OVERLOCK_1', 'QC', 'WTO', 'PACKING'];

// ---------------------------------------------------------------------------

async function login(loginName, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-host': HOST },
    body: JSON.stringify({ login: loginName, password }),
  });
  if (!res.ok) throw new Error(`login ${loginName}: HTTP ${res.status} ${await res.text()}`);
  const m = /sewing_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login ${loginName}: нет cookie`);
  return `sewing_session=${m[1]}`;
}

async function call(cookie, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-tenant-host': HOST, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}
const rows = (r) => (Array.isArray(r.json) ? r.json : (r.json?.items ?? r.json?.data ?? []));
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.status} ${r.json?.code ?? ''} ${r.json?.message ?? JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
};
const isoDate = (d) => d.toISOString().slice(0, 10);

/** Смена нужного сотрудника на нужном месте/операции (переиспользует открытую). */
async function ensureShift(cookie, who, eqByCode, opByCode, eqCode, opCode) {
  const cur = await call(cookie, 'GET', '/api/shifts/current');
  if (cur.ok && cur.json?.active) {
    if (cur.json.equipmentId === eqByCode[eqCode].id && cur.json.operationId === opByCode[opCode].id) return;
    const work = await call(cookie, 'GET', '/api/shifts/current-work');
    if (rows(work).length > 0) {
      throw new Error(`${who}: открыта смена с паспортами на руках — сначала node scripts/demo/expo-setup.mjs`);
    }
    must(await call(cookie, 'POST', '/api/shifts/stop', {}), `${who}: stop shift`);
  }
  must(
    await call(cookie, 'POST', '/api/shifts/start', { equipmentId: eqByCode[eqCode].id, operationId: opByCode[opCode].id }),
    `${who}: start shift ${eqCode}/${opCode}`,
  );
}

// ---------------------------------------------------------------------------

const admin = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
console.log(`Тенант ${HOST} через ${API}`);

// справочники
const equipment = rows(await call(admin, 'GET', '/api/equipment'));
const operations = rows(await call(admin, 'GET', '/api/operations'));
const eqByCode = Object.fromEntries(equipment.map((e) => [e.code, e]));
const opByCode = Object.fromEntries(operations.map((o) => [o.code, o]));
for (const c of ['cutting-table-01', 'overlock-01']) if (!eqByCode[c]) throw new Error(`нет оборудования ${c}`);
for (const c of ['CUT_CUT', ...ROUTE_OPS]) if (!opByCode[c]) throw new Error(`нет операции ${c}`);

// 1. клиент
let client = rows(await call(admin, 'GET', '/api/clients')).find((c) => c.name === CLIENT_NAME);
if (!client) client = must(await call(admin, 'POST', '/api/clients', { name: CLIENT_NAME }), 'create client');
console.log(`[1] клиент: ${client.name}`);

// 2. шаблон маршрута
let route = rows(await call(admin, 'GET', '/api/routes')).find((r) => r.code === ROUTE_CODE);
if (!route) {
  route = must(
    await call(admin, 'POST', '/api/routes', { code: ROUTE_CODE, name: ROUTE_NAME, steps: ROUTE_OPS.map((code) => ({ operationId: opByCode[code].id })) }),
    'create route',
  );
}
console.log(`[2] маршрут: ${route.name}`);

// 3. номенклатура + размеры
const patterns = rows(await call(admin, 'GET', '/api/patterns'));
const pattern = patterns.find((p) => p.name === PATTERN_NAME);
if (!pattern) throw new Error(`номенклатура «${PATTERN_NAME}» не найдена; есть: ${patterns.map((p) => p.name).join(', ')}`);
const sizes = rows(await call(admin, 'GET', '/api/sizes'));
const sizeByCode = Object.fromEntries(sizes.map((s) => [s.code, s]));
for (const c of SIZE_CODES) if (!sizeByCode[c]) throw new Error(`размер ${c} не найден; есть: ${sizes.map((s) => s.code).join(' ')}`);

// 4. заказ
const today = new Date();
const due = new Date(today.getTime() + 14 * 86400e3);
const order = must(
  await call(admin, 'POST', '/api/orders', {
    orderDate: isoDate(today),
    dueDate: isoDate(due),
    clientId: client.id,
    patternItemId: pattern.id,
    routeTemplateId: route.id,
    comment: 'Демо-заказ для стенда (создан scripts/demo/expo-demo-order.mjs)',
    items: SIZE_CODES.map((c) => ({ sizeId: sizeByCode[c].id, qtyPlan: QTY })),
    variants: [{ color: COLOR, sizes: SIZE_CODES.map((c) => ({ sizeId: sizeByCode[c].id, qtyPlan: QTY })) }],
  }),
  'create order',
);
must(await call(admin, 'POST', `/api/orders/${order.id}/start`, {}), 'start order');
console.log(`[3] заказ ${order.number ?? order.id}: ${pattern.name}, ${COLOR}, ${SIZE_CODES.map((c) => `${c}×${QTY}`).join(' ')} — в производстве`);

// 5. раскрой → паспорта → ячейка
// Живой раскройщик (`CUTTER`) паспорта руками не выпускает — только через
// задание раскроя в /cutter (расклады → «Выпуск»). Для пресида берём
// управленческую ручку `POST /api/passports` (SHOP_MANAGER/ADMIN) с явным
// `cutterId`, чтобы начисление за раскрой легло на expo-cutter.
const cutterEmp = rows(await call(admin, 'GET', '/api/employees')).find((e) => e.login === 'expo-cutter');
if (!cutterEmp) throw new Error('нет сотрудника expo-cutter — сначала node scripts/demo/expo-setup.mjs');
const cells = rows(await call(admin, 'GET', '/api/cells')).filter((c) => c.active !== false);
const cell = cells[0];
const passports = [];
for (const c of SIZE_CODES) {
  const p = must(
    await call(admin, 'POST', '/api/passports', {
      orderId: order.id,
      sizeId: sizeByCode[c].id,
      cutDate: isoDate(today),
      qtyCut: QTY,
      rollNumber: '4',
      cutterId: cutterEmp.id,
    }),
    `create passport ${c}`,
  );
  if (cell) {
    const placed = await call(admin, 'POST', `/api/passports/${p.id}/place`, { cellId: cell.id });
    if (!placed.ok) console.log(`    ! ${p.number}: в ячейку не положил (${placed.json?.code ?? placed.status}) — с маршрутом это не блокирует выдачу`);
  }
  passports.push({ ...p, sizeCode: c });
}
console.log(`[4] раскрой: ${passports.length} паспорт(а) выпущены на expo-cutter${cell ? `, ячейка ${cell.code ?? cell.name ?? ''}` : ''}`);

// 6. (опционально) швея берёт крой
if (STAGE === 'sewing') {
  const seam = await login('expo-seamstress', PIN);
  await ensureShift(seam, 'expo-seamstress', eqByCode, opByCode, 'overlock-01', 'SEW_OVERLOCK_1');
  for (const p of passports) {
    must(await call(seam, 'POST', `/api/passports/${p.id}/issue`, {}), `issue ${p.number}`);
  }
  console.log(`[5] пошив: expo-seamstress взяла крой по всем паспортам (смена на оверлоке открыта)`);
}

// монитор
const display = await call(admin, 'GET', '/api/shopfloor/display');
if (display.ok) {
  const stages = display.json?.stages ?? display.json?.buckets ?? display.json?.totals;
  if (Array.isArray(stages)) {
    console.log('\nМонитор цеха сейчас:');
    for (const s of stages) console.log(`  ${String(s.stage ?? s.code ?? s.key).padEnd(14)} ${s.qty ?? s.total ?? s.count ?? ''}`);
  } else if (stages && typeof stages === 'object') {
    console.log('\nМонитор цеха сейчас:');
    for (const [k, v] of Object.entries(stages)) console.log(`  ${k.padEnd(14)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
}

console.log(`
Ссылки:
  заказ:        ${API}/orders/${order.id}
  монитор:      ${API}/shopfloor/display   (логин display)
  паспорта — это их сканируют на стенде (этикетку можно показать с экрана):`);
for (const p of passports) console.log(`    ${p.number}  ${p.sizeCode.padEnd(4)} ${API}/api/passports/${p.id}/print`);
console.log(`
Дальше руками: ${STAGE === 'cut' ? 'телефон expo → «Начать смену» → QR блока 5 → «Взять крой» → скан этикетки паспорта' : 'телефон expo-seamstress → «Операция закрыта» → ОТК сканирует паспорт'}.`);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}
