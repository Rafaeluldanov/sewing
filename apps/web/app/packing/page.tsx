import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { OrderCutIssueRuleBannerDto } from '@sewing/shared';
import type {
  CurrentWorkPassportDto,
  ReworkPassportDto,
} from '@sewing/shared/shifts';
import { listBoxes, BOX_STATUS_LABELS } from '@/lib/packing-api';
import {
  getCurrentShift,
  getCurrentWork,
  getCutIssueBanner,
  getMyRework,
  getShiftMeta,
} from '@/lib/shifts-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getActiveWorkplaceLabel } from '@/lib/rbac';
import { ApiRequestError } from '@/lib/api';
import { operationsForEquipment } from '@/lib/equipment-operations';
import { TerminalShell } from '@/components/terminal-shell';
import { CreateBoxForm } from './create-box-form';
import { PackingTerminal } from './packing-terminal';

export const dynamic = 'force-dynamic';

interface SearchParams {
  status?: string;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export default async function PackingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/packing');

  // -----------------------------------------------------------------
  // PACKING-роль → scan-driven терминал. Это единственная точка входа
  // упаковщика (см. `lib/rbac.ts` SINGLE_WORKSPACE_ROLES, ADR-0011).
  // SHOP_MANAGER/ADMIN видят прежний управленческий список ниже.
  // -----------------------------------------------------------------
  if (me.user.role === 'PACKING') {
    const meta = await getShiftMeta();
    const employee = meta.employees.find((e) => e.id === me.user.id) ?? {
      id: me.user.id,
      login: me.user.login,
      fullName: me.user.fullName,
      role: me.user.role,
    };

    let shift = null;
    try {
      shift = await getCurrentShift();
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
    }

    // -----------------------------------------------------------------
    // Какой именно терминал показать, решает операция активной смены.
    //
    // Категории `PACKING` для этого НЕ хватает: в одном маршруте таких
    // операций бывает две — «Распаковка» (приёмка и распаковка
    // приходящего сырья) первым шагом и «Упаковка» (коробки) последним.
    // Разводит их явный признак `Operation.boxPacking`
    // (см. `prisma/schema.prisma::Operation`, `PackingService
    // .assertPackingActor`): только он включает окно коробок. Раньше
    // развилка шла по категории, и смена на «Распаковке» открывала
    // коробки, где первый же скан валился 409 `PASSPORT_NOT_QC_PASSED`
    // (гейт финальной упаковки требует пройденных ОТК/ВТО).
    //
    // Не путать с `Operation.producesFinishedGoods` — та ось про
    // финансовый выпуск готовой продукции (`FinishedGoodsMovement`).
    // -----------------------------------------------------------------
    const operation = shift
      ? meta.operations.find((o) => o.id === shift.operationId)
      : null;
    const activeOperationCategory = operation?.category ?? null;
    const activeOperationBoxPacking = operation?.boxPacking ?? false;
    const isShiftActive = !!(shift && shift.active);
    // Режим коробок — смена активна И операция помечена `boxPacking`.
    const isBoxPackingMode = isShiftActive && activeOperationBoxPacking;
    // Режим «обычная производственная операция упаковщика»: смена на
    // PACKING-операции без коробок («Распаковка»). Работает ровно как у
    // швеи на /work — скан паспорта → взять / завершить операцию.
    const isPlainPackingMode =
      isShiftActive &&
      !activeOperationBoxPacking &&
      activeOperationCategory === 'PACKING';

    // Список незакрытых коробок — на Stage 1 терминала (когда у
    // упаковщика нет активной карточки) показываем общий пул `OPEN`
    // коробок, чтобы можно было вернуться к любой из них одним кликом
    // и не терять коробки, открытые с другого устройства/коллегой.
    // fail-soft: если backend временно недоступен, отдаём пустой
    // список — терминал всё равно умеет создать новую коробку.
    // Грузим только в режиме коробок: в остальных ветках эти списки
    // никто не рендерит (`PackingMainTerminal` — единственный
    // потребитель), и два лишних запроса были бы холостыми.
    let initialOpenBoxes: Awaited<ReturnType<typeof listBoxes>>['items'] = [];
    let initialClosedUnplacedBoxes: Awaited<
      ReturnType<typeof listBoxes>
    >['items'] = [];
    if (isBoxPackingMode) {
      try {
        const page = await listBoxes({ status: 'OPEN', page: 1, pageSize: 50 });
        initialOpenBoxes = page.items;
      } catch (e) {
        if (!(e instanceof ApiRequestError)) throw e;
      }

      // Список «закрытых, но ещё не размещённых» — упаковщик должен
      // видеть, какие коробки уже упакованы и ждут разноса по ячейкам.
      // После размещения через `placeBoxTerminalAction` коробка
      // пропадает из этого списка (см. `Box.placedAt`).
      try {
        const page = await listBoxes({
          status: 'CLOSED',
          placed: false,
          page: 1,
          pageSize: 50,
        });
        initialClosedUnplacedBoxes = page.items;
      } catch (e) {
        if (!(e instanceof ApiRequestError)) throw e;
      }
    }

    // -----------------------------------------------------------------
    // Данные швейного flow для второго режима терминала.
    //
    // На «Распаковке» упаковщик работает обычным паспортным потоком, и
    // экран мы не плодим заново, а переиспользуем `SeamstressActivePanel`
    // из /work. Значит, ему нужны ровно те же три источника, что грузит
    // `apps/web/app/work/page.tsx` (см. `loadCurrentWorkSafely` и
    // соседей): активные паспорта сотрудника, баннер очереди выдачи
    // кроя по операции смены и список возвратов от ОТК.
    //
    // fail-soft такой же, как у `listBoxes` выше: бизнес-ошибка backend
    // не должна ронять весь терминал — меню действий («Завершить смену»,
    // «Выйти») обязано остаться доступным в любом случае.
    // -----------------------------------------------------------------
    let currentWork: CurrentWorkPassportDto[] = [];
    let myRework: ReworkPassportDto[] = [];
    let cutIssueBanner: OrderCutIssueRuleBannerDto = {
      applicable: false,
      orders: [],
    };
    if (isPlainPackingMode) {
      const [work, banner, rework] = await Promise.all([
        getCurrentWork().catch((e) => {
          if (!(e instanceof ApiRequestError)) throw e;
          return [] as CurrentWorkPassportDto[];
        }),
        getCutIssueBanner(shift!.operationId).catch((e) => {
          if (!(e instanceof ApiRequestError)) throw e;
          return { applicable: false, orders: [] } as OrderCutIssueRuleBannerDto;
        }),
        getMyRework().catch((e) => {
          if (!(e instanceof ApiRequestError)) throw e;
          return [] as ReworkPassportDto[];
        }),
      ]);
      currentWork = work;
      cutIssueBanner = banner;
      myRework = rework;
    }
    const headerFields = isShiftActive
      ? [
          {
            label: 'Операция',
            value: shift!.operationName,
            meta: shift!.operationCode,
          },
          {
            label: 'Оборудование',
            value: shift!.equipmentName,
            meta: shift!.equipmentCode,
          },
        ]
      : [];

    // Операции, разрешённые на рабочем месте текущей смены
    // (`EquipmentOperation`, ADR-0017). Если их 2+ — терминал отрендерит
    // chip «Сменить операцию» и упаковщик перейдёт с «Упаковки» на
    // «Распаковку» не завершая смену: рабочее место-то одно и то же.
    // Считаем ровно как `/work/page.tsx`, через общий хелпер.
    const currentEquipment = shift
      ? meta.equipment.find((e) => e.id === shift.equipmentId)
      : null;
    const availableOperations = currentEquipment
      ? operationsForEquipment(currentEquipment, meta.operations)
      : [];

    return (
      <TerminalShell
        name={employee.fullName}
        role={getActiveWorkplaceLabel(me.user)}
        fields={headerFields}
        shiftActive={isShiftActive}
        statusText={
          isShiftActive
            ? `Смена с ${formatTime(shift!.startedAt)}`
            : 'Смена не начата — отсканируйте QR оборудования упаковки'
        }
      >
        <PackingTerminal
          meta={meta}
          employee={employee}
          initialShift={shift}
          activeOperationCategory={activeOperationCategory}
          activeOperationBoxPacking={activeOperationBoxPacking}
          availableOperations={availableOperations}
          initialOpenBoxes={initialOpenBoxes}
          initialClosedUnplacedBoxes={initialClosedUnplacedBoxes}
          currentWork={currentWork}
          cutIssueBanner={cutIssueBanner}
          myRework={myRework}
        />
      </TerminalShell>
    );
  }

  // -----------------------------------------------------------------
  // SHOP_MANAGER / ADMIN — управленческий вид: список коробок + форма
  // создания. Никаких визуальных изменений по сравнению с MVP §6.1.
  // -----------------------------------------------------------------
  const status =
    searchParams.status === 'CLOSED' || searchParams.status === 'OPEN'
      ? searchParams.status
      : undefined;

  const meta = await getShiftMeta();
  const employee = meta.employees.find((e) => e.id === me.user.id) ?? {
    id: me.user.id,
    login: me.user.login,
    fullName: me.user.fullName,
    role: me.user.role,
  };

  let shift = null;
  try {
    shift = await getCurrentShift();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }

  const shiftOperation = shift
    ? meta.operations.find((o) => o.id === shift.operationId)
    : null;
  // Форма «Новая коробка» ниже упирается в тот же серверный гейт, что и
  // терминал: `PackingService.assertPackingActor` пускает только смену
  // на операции с `Operation.boxPacking`. Поэтому и здесь смотрим на
  // признак, а не на категорию — иначе кнопка была бы активна на смене
  // «Распаковка» (тоже категория PACKING) и падала бы 409
  // `PACKING_SHIFT_REQUIRED` уже после клика.
  const onPackingShift =
    !!shift && shift.active && (shiftOperation?.boxPacking ?? false);

  const { items, total } = await listBoxes({
    status,
    page: 1,
    pageSize: 100,
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Упаковка</h1>
          <div className="meta-line">
            Управленческий вид: список коробок и быстрый доступ к
            карточкам. Упаковщикам открывается scan-driven терминал.
          </div>
        </div>
      </div>

      {!employee && (
        <div className="error-box">
          Сначала выберите сотрудника на{' '}
          <Link href="/work">/work</Link>: упаковка требует, чтобы у вас
          была активная смена на операции категории «Упаковка».
        </div>
      )}
      {employee && !onPackingShift && (
        <div className="info-box">
          У выбранного сотрудника <strong>{employee.fullName}</strong> нет
          активной смены на упаковке в коробки. Создание коробок отсюда
          тоже доступно только из-под такой смены — приёмка/распаковка
          сырья не подойдёт, хотя и лежит в той же категории.
        </div>
      )}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Новая коробка</h2>
        <p className="meta-line" style={{ margin: '0 0 0.75rem' }}>
          Рекомендуемая вместимость — 100 шт.; коробка должна быть
          однородной по изделию, цвету и размеру. Лимит можно задать
          любым целым {`> 0`} — увеличить или уменьшить в зависимости
          от того, что физически вмещает коробка.
        </p>
        <CreateBoxForm disabled={!onPackingShift} />
      </div>

      <form method="get" className="toolbar">
        <label htmlFor="status">Статус</label>
        <select id="status" name="status" defaultValue={status ?? ''}>
          <option value="">Все</option>
          <option value="OPEN">Открытые</option>
          <option value="CLOSED">Закрытые</option>
        </select>
        <button type="submit" className="btn">
          Применить
        </button>
        <span className="meta-line" style={{ marginLeft: 'auto' }}>
          Найдено: <strong>{total}</strong>
        </span>
      </form>

      {items.length === 0 ? (
        <div className="card empty">
          Коробок пока нет. Создайте первую через форму выше.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Коробка</th>
              <th>Партия</th>
              <th>Содержимое</th>
              <th className="num">Упаковано</th>
              <th>Создана</th>
              <th>Закрыта</th>
              <th>Кто открыл</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <td>
                  <strong>{b.number}</strong>
                  <div className="meta-line">
                    <span
                      className={`status-badge ${
                        b.status === 'CLOSED' ? 'done' : 'in_production'
                      }`}
                    >
                      {BOX_STATUS_LABELS[b.status]}
                    </span>
                  </div>
                </td>
                <td>
                  {b.summary ? (
                    <>
                      {b.summary.productName}
                      <div className="meta-line">
                        {b.summary.color} · {b.summary.sizeCode}
                      </div>
                    </>
                  ) : (
                    <span className="meta-line">—</span>
                  )}
                </td>
                <td>{b.itemsCount} паспорт(ов)</td>
                <td className="num">
                  <strong>{b.totalQty}</strong> шт.
                </td>
                <td>{formatDateTime(b.createdAt)}</td>
                <td>{b.closedAt ? formatDateTime(b.closedAt) : '—'}</td>
                <td>{b.createdByName}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link
                    className="btn btn-primary"
                    href={`/packing/boxes/${b.id}`}
                  >
                    Открыть
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
