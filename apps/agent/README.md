# sewing-print-agent

Минимальный print-агент для Windows-станции рядом с принтером.
Один self-contained `.exe`, без GUI и автообновлений: подключился по
pairing-коду — раз в 2-3 секунды опрашивает API, скачивает payload-ы
print-job-ов, складывает их в локальную папку и подтверждает статус.

См. контракт API в `docs/api.md §16` и доменную модель в
`docs/domain.md §17`.

## Что делает агент

1. **Pairing.** Менеджер в `/admin/printers/<id>` жмёт «Сгенерировать
   код» и отдаёт его оператору. Оператор запускает агент с
   `--pair --server <URL> --code <CODE>`. Агент дергает
   `POST /api/printers/agent/pair`, получает постоянный
   `agentToken + printerId + printerName` и сохраняет это в
   `agent-config.json` рядом с exe.
2. **Polling loop** (без `--pair`):
   - `POST /api/printers/agent/heartbeat` — UI рисует «онлайн». Ответ
     содержит `selectedWindowsPrinter` — текущий выбор менеджера, агент
     держит его в памяти как fallback на случай, если в job его не будет.
   - раз в ~60 секунд (и сразу при старте) — `POST /api/printers/agent/windows-printers`
     с `{ hostName: os.hostname(), printers: listWindowsPrinters() }`.
     На Windows `listWindowsPrinters()` запускает PowerShell
     `Get-Printer | Select-Object -ExpandProperty Name`. На любой
     не-Windows платформе возвращается пустой список (агент полезен
     для разработки/тестов и без принтеров).
   - `GET  /api/print-jobs/agent` — забираем `PENDING` job (0 или 1).
     В `PrintJobDto` лежит `selectedWindowsPrinter` — куда печатать.
   - если есть job — скачиваем `payloadUrl`, кладём в `spool/`;
   - переносим в `printed/` и `PATCH /api/print-jobs/:id` со статусом
     `PRINTED`;
   - на любой ошибке — переносим в `failed/`, шлём `FAILED` с
     `errorMessage`.

### Логический Printer vs физический Windows-принтер

Логический `Printer` в системе (`/admin/printers/<id>`) и физический
Windows-принтер на машине агента — разные сущности. На одной
Windows-станции обычно несколько принтеров (HP LaserJet, Zebra ZD220,
Microsoft Print to PDF), и агент должен знать, на какой из них печатать.

- агент шлёт `availableWindowsPrinters` + `agentHostName` →
  `POST /api/printers/agent/windows-printers`;
- менеджер видит этот список в карточке принтера и выбирает один →
  `PATCH /api/printers/:id { selectedWindowsPrinter }`;
- сервер кладёт `selectedWindowsPrinter` в каждый `PrintJobDto`;
- агент использует `job.selectedWindowsPrinter` (или
  `state.selectedWindowsPrinter` из последнего heartbeat) при обработке
  job-а.

Если `selectedWindowsPrinter` ещё не выбран, агент **не печатает** и
сразу закрывает job как `FAILED` с понятным `errorMessage` («Не выбран
Windows-принтер для логического принтера…») — менеджер видит ошибку
в `/admin/printers/<id>` и понимает, что нужно сделать.

### Реальная печать

Когда `selectedWindowsPrinter` выбран, агент **реально печатает** на
этот системный Windows-принтер. Стратегия зависит от формата
payload-а (см. `src/windows-print.mjs`):

- `.pdf`, `.txt` — стандартный Windows ShellExecute через PowerShell
  `Start-Process -Verb PrintTo`. Зарегистрированный в реестре handler
  (Adobe Reader/Foxit/Edge для PDF, Notepad для TXT) ставит документ
  в очередь нужного принтера и завершается; агент ждёт его выхода и
  только после этого помечает job как `PRINTED`.
- `.html`, `.htm` — напрямую через **Chrome или Edge** в silent-режиме
  `--kiosk-printing`. Раньше HTML тоже печатался через `PrintTo`, но
  у Windows нет надёжной ассоциации `printto` для `.html` —
  получалась ошибка «файлу не сопоставлено приложение». Теперь агент
  ищет `chrome.exe` / `msedge.exe` в стандартных путях, через
  `WScript.Network → SetDefaultPrinter` временно делает выбранный
  принтер дефолтным, оборачивает payload в HTML с авто-`window.print()`
  и запускает браузер. Браузер тихо отправляет страницу на default
  printer, агент ждёт ~15 секунд (этого хватает для попадания в
  спулер) и убивает процесс.

Поддерживаемые форматы:

- `.html`, `.htm` — через Chrome/Edge `--kiosk-printing` (см. выше).
- `.pdf` — через установленный PDF-viewer с поддержкой `printto`
  (Adobe Reader, Foxit, современный Edge). Если на машине такого
  viewer-а нет, job закроется как `FAILED` с сообщением «PowerShell
  print command failed: There is no application associated with the
  specified file…» — это значит «поставьте PDF-viewer и выберите его
  дефолтным для .pdf».
- `.txt` — через Notepad.
- Всё остальное → `FAILED` с сообщением `Unsupported print file type:
  <ext>`.

Возможные ошибки печати (попадают в `PrintJob.errorMessage`, видны в
`/admin/print-jobs/<id>`):

- `Windows printing is supported only on Windows agents` — агент
  запущен на Linux/macOS;
- `Selected Windows printer was not provided` — менеджер не выбрал
  физический принтер в `/admin/printers/<id>`;
- `Selected Windows printer not found: <name>` — выбранный принтер
  больше не виден в системе (отключили USB / удалили драйвер);
- `Chrome/Edge not found on system for HTML printing` — на машине
  нет ни `chrome.exe`, ни `msedge.exe` в стандартных путях; HTML
  печатать нечем, поставьте Chrome или Edge;
- `Unsupported print file type: <ext>` — пришёл payload, который мы
  пока не умеем печатать (например, `.svg`, `.docx`);
- `PowerShell print command failed: <stderr>` — Windows вернул
  ошибку (не зарегистрирован handler, нет драйвера принтера, нет
  PowerShell);
- `Browser print command failed: <reason>` — Chrome/Edge не запустился
  или упал с ненулевым кодом до того, как мы успели прибить процесс
  по таймауту;
- `Print helper did not exit within 60000ms` — handler-приложение
  PrintTo зависло; payload уйдёт в `failed/`, попробуйте
  перезапустить печать вручную.

## Структура

```
apps/agent
├── package.json
├── README.md
├── .gitignore
└── src
    ├── index.mjs       # CLI entrypoint, парсинг аргументов
    ├── runtime.mjs     # runPair, runLoop, processJob
    ├── api.mjs         # fetch-обёртки над /api/printers/agent/*, /print-jobs/*
    ├── config.mjs      # load/save agent-config.json
    ├── filesystem.mjs  # spool/printed/failed, имена файлов
    ├── windows-printers.mjs # listWindowsPrinters() через PowerShell Get-Printer
    ├── windows-print.mjs    # printFileOnWindows() через PowerShell Start-Process -Verb PrintTo
    └── logger.mjs      # info / warn / error в stdout/stderr
```

Зависимостей в рантайме **нет**: только Node 18+ для глобального
`fetch`. Дев-зависимости (`esbuild`, `@yao-pkg/pkg`) нужны только для
сборки exe и в собранный artifact не попадают.

## Запуск из исходников (для разработки)

```bash
cd apps/agent
npm install

# Pairing — задаём URL сервера и код подключения:
npm run pair -- --server https://stage.teeon.ru --code PAIR-XXXX-XXXX
# или напрямую:
node src/index.mjs --pair --server https://stage.teeon.ru --code PAIR-XXXX-XXXX

# Рабочий цикл (ожидает существующий agent-config.json):
npm start
# или:
node src/index.mjs
```

После успешного pair-а в текущей папке появится `agent-config.json`.
Этот файл — секрет (внутри `agentToken`), храните в профиле
пользователя и не коммитьте.

## Сборка Windows .exe

```bash
cd apps/agent
npm install
npm run build:win
```

Результат: **`apps/agent/dist/sewing-print-agent.exe`** (один файл,
~40 МБ — внутри Node runtime).

Под капотом (`npm run build:win` = `clean → bundle → pkg`):

1. `clean` — удаляет `dist/` целиком, чтобы не тащить старый `bundle.cjs`
   или exe от прошлой сборки.
2. `bundle` — `esbuild src/index.mjs --bundle --platform=node --target=node20 --format=cjs --outfile=dist/bundle.cjs`.
   Получаем один CommonJS файл, который pkg может «съесть» как entry.
   Шебанг (`#!/usr/bin/env node`) живёт ровно в одном месте — в первой
   строке `src/index.mjs`; esbuild его сохраняет, **никаких** дополнительных
   `--banner:js` мы не добавляем (иначе в `bundle.cjs` оказывалось бы две
   строки с шебангом подряд, babel внутри pkg падал бы на `Unexpected token
   (2:0)`, bytecode для entry не собирался, и exe стартовал с ошибкой
   `Cannot find module 'C:\snapshot\dist\bundle.cjs'`).
3. `pkg dist/bundle.cjs --targets node20-win-x64 --output dist/sewing-print-agent.exe --compress GZip`
   через `@yao-pkg/pkg` (поддерживаемый форк `vercel/pkg`). pkg запекает
   `bundle.cjs` в snapshot вместе с Node-runtime.

Здоровая сборка в логах не должна содержать строк
`Warning Babel parse has failed` или
`Failed to make bytecode node20-x64 for file C:\snapshot\dist\bundle.cjs`
— если они есть, exe будет битый.

При первой сборке `pkg` скачает базовый Node-binary под Windows
(~30 МБ) — нужна сеть.

Кросс-сборка с Linux/macOS работает: на CI/dev-машине разработчика
можно собрать exe и положить его на сервер, агент сам не нужен.

### Быстрая проверка собранного exe

После `npm run build:win` на любой машине (Windows или Linux+wine)
прогоняем минимальный smoke:

```cmd
:: 1. Help — должен напечатать usage и выйти с кодом 0,
::    БЕЗ "Cannot find module 'C:\snapshot\dist\bundle.cjs'":
sewing-print-agent.exe --help

:: 2. Pair — должен дойти до сетевого вызова pairAgent.
::    Если сервер недоступен/код невалидный — упадёт на fetch/HTTP,
::    но это уже доказывает, что bundle.cjs корректно внутри snapshot:
sewing-print-agent.exe --pair --server https://stage.teeon.ru --code TEST
```

Если оба шага проходят — артефакт готов к раздаче через
`GET /api/printers/agent-download/sewing-print-agent.exe`.

## Запуск exe на Windows-станции

```cmd
sewing-print-agent.exe --pair --server https://api.example.com --code PAIR-XXXX-XXXX
sewing-print-agent.exe
```

Рядом с exe появятся:

- `agent-config.json` — конфиг с `printerId + agentToken`;
- `spool/`            — payload-ы во время скачивания;
- `printed/`          — успешно обработанные;
- `failed/`           — упавшие, с тем же именем для разбора.

Имя файла внутри: `job-<id>-<timestamp>.<ext>`, где расширение
выводится из `Content-Type` (`.html`, `.pdf`, `.png`, …) или из URL,
fallback — `.bin`.

Остановить агент — `Ctrl+C`. Логи идут в stdout/stderr.

## CLI-опции

| Флаг                   | Описание                                                  |
| ---------------------- | --------------------------------------------------------- |
| `--pair`               | Включить режим pairing (нужны `--server` и `--code`).     |
| `--server <URL>`       | Базовый URL backend (например, `https://api.example.com`).|
| `--code <PAIRING_CODE>`| Короткий код, сгенерированный в `/admin/printers/<id>`.   |
| `--config <path>`      | Путь к JSON-конфигу (по умолчанию `./agent-config.json`). |
| `--help`, `-h`         | Справка.                                                  |

## Переменные окружения

| Переменная           | Зачем                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `AGENT_CONFIG_PATH`  | Альтернатива `--config`, путь к agent-config.json.                 |
| `AGENT_OUTPUT_DIR`   | Родитель для `spool/printed/failed` (по умолчанию рабочая папка).  |
| `POLL_INTERVAL_MS`   | Интервал опроса (по умолчанию `3000`).                             |
| `SERVER_URL`         | Fallback для `--server` при `--pair`.                              |

## Раздача exe через сервис

Backend уже умеет отдавать собранный exe через
`GET /api/printers/agent-download/sewing-print-agent.exe`
(см. `apps/api/src/modules/printers/printers.controller.ts`,
`docs/api.md §16`).

Контроллер ищет файл в нескольких местах:

1. `<cwd>/apps/agent/dist/sewing-print-agent.exe`
2. `<cwd>/../agent/dist/sewing-print-agent.exe`
3. `<__dirname>/../../../../agent/dist/sewing-print-agent.exe`

Чтобы кнопка «Скачать агент» в `/admin/printers/<id>` начала работать,
достаточно положить собранный `dist/sewing-print-agent.exe` в
`apps/agent/dist/` на сервере (или на CD выкатить артефакт по тому же
пути). Если файла нет — endpoint вернёт 404 с кодом
`AGENT_BUNDLE_NOT_FOUND` и понятным сообщением.

## Verify path (ручная проверка end-to-end)

1. `cd apps/agent && npm install && npm run build:win` — собрали
   `dist/sewing-print-agent.exe`.
2. На Windows-станции запустили
   `sewing-print-agent.exe --pair --server <URL> --code <CODE>` →
   в консоли «Pairing successful» / «Printer connected».
3. Запустили `sewing-print-agent.exe` без флагов → каждые 3 секунды:
   `Heartbeat ok` + `No pending jobs`. На UI принтер становится «online».
   В первой же итерации в логах: `Host: QC-PC-01`,
   `Found N Windows printers: HP LaserJet, Zebra ZD220, …`,
   `Uploaded windows printers (selected: <none>)`. В
   `/admin/printers/<id>` появляется блок «Физический принтер Windows»
   со списком и `agentHostName`.
4. В `/admin/printers/<id>` менеджер выбирает в `<select>`
   физический принтер, жмёт «Сохранить выбор». Сервер делает
   `PATCH /api/printers/:id { selectedWindowsPrinter }`. В следующем
   heartbeat-е агент видит новый `selectedWindowsPrinter` и пишет
   в логе `Selected windows printer: Zebra ZD220`.
5. В UI системы нажали «Печать» (или «Тестовая печать» в
   `/admin/printers/<id>`):
   - в логах агента: `Job downloaded`, `Detected print kind: html`,
     `Printing job <id> to Zebra ZD220`,
     `Print command completed successfully`, `Saved to printed`,
     `Job <id> marked as PRINTED`;
   - на принтере физически вылез лист / этикетка;
   - файл лежит в `printed/job-<id>-<timestamp>.<ext>`.
   Если `selectedWindowsPrinter` ещё не выбран — задание сразу
   закрывается как `FAILED` («Не выбран Windows-принтер для логического
   принтера…»).
6. Чтобы проверить FAILED-ветку — поднимите backend, временно ломайте
   payload (напр. забирайте 500 в `payloadUrl`): файл должен оказаться
   в `failed/`, статус job-а в БД — `FAILED` с `errorMessage`.
7. Чтобы проверить «принтер не найден» — выберите в UI любой принтер,
   потом физически отключите его / удалите из системы. Job закроется
   как `FAILED: Selected Windows printer not found: <name>` без
   попытки реальной печати.

## Что нужно на Windows-машине

- Windows 10/11 с установленным PowerShell (`powershell.exe` в PATH —
  присутствует по умолчанию). На «голом» Server Core / урезанном
  образе без PowerShell печать не заработает.
- Драйвер выбранного принтера (он же должен быть видно в
  `Get-Printer | Select-Object Name`).
- Для `.html`/`.htm` — установленный **Chrome или Edge** в стандартных
  путях (`C:\Program Files\Google\Chrome\Application\chrome.exe`
  или `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`).
  Через них агент печатает в silent-режиме `--kiosk-printing` без
  диалога. Если ни одного нет — job закроется как
  `Chrome/Edge not found on system for HTML printing`.
- Для `.pdf`/`.txt` — зарегистрированный handler с глаголом `printto`:
  Adobe Reader / Foxit / Edge для `.pdf`, Notepad для `.txt`. Если
  печать на `.pdf` падает с «There is no application associated…» —
  поставьте Adobe Reader и сделайте его дефолтным для `.pdf`.

## Что делать, если печать не идёт

1. Откройте `/admin/print-jobs/<id>` (или `failed/`-папку рядом с
   exe) и посмотрите `errorMessage` упавшего job-а — он точно
   соответствует одной из ошибок в разделе «Реальная печать» выше.
2. На Windows-машине проверьте, что выбранный принтер вообще виден:
   `powershell.exe -Command "Get-Printer | Select-Object Name"`.
3. Попробуйте напечатать тот же файл вручную: правый клик по
   `printed/<file>` → «Печать». Если ручная печать тоже не работает —
   проблема в драйвере / handler-е, а не в агенте.
4. Если печать не отправляется вообще, перезапустите службу
   «Диспетчер печати» (`Spooler`) и сам агент.

## Что MVP сознательно НЕ делает

- Нет tray-app, GUI, авто-апдейта, очереди ретраев, service-manager,
  installer-wizard. Если упало — `Ctrl+C` + перезапуск.
- Нет логирования в файл — Windows-станция жива, пока открыта консоль.
- Не пытается рендерить неподдерживаемые форматы (`.svg`, `.docx`,
  raw-ZPL и т.п.). Решение специально на стороне backend-а: агент
  отвечает только за «отправь готовый файл на принтер».
- Не следит за реальным состоянием принтера (бумага закончилась,
  застряла, оффлайн). Считается успехом, как только Windows
  поставил документ в очередь.
