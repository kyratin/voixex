# Voixex

Голосовые и текстовые каналы в стиле Discord: **десктоп (Electron)**, веб-интерфейс (**Next.js**) и сервер (**Fastify + WebSocket + UDP-микшер**).

Эта ветка — **`macos`** (основная клиентская): здесь живут `primer_front`, `desktop-client`, `voice-client`.

| Путь | Назначение |
|------|------------|
| [`primer_front/`](primer_front) | UI на Next.js; при сборке клиента экспорт статики копируется в `desktop-client/ui` |
| [`desktop-client/`](desktop-client) | Electron: окно, IPC, захват экрана, инсталляторы |
| [`voice-client/`](voice-client) | UDP-движок голоса (`file:`-зависимость десктопа) |

**Версия десктопа** — поле `version` в [`desktop-client/package.json`](desktop-client/package.json).

**Сервер** (REST, WebSocket, микшер UDP, SQLite) — отдельная ветка **[`server`](../tree/server)** (или форк только с backend). Подключение в приложении: `http://<хост>:<порт>` (часто `18080`).

---

## Требования

- **Node.js** 20+ (рекомендуется 22)
- **npm**
- Работающий **backend** (локально или на VPS), если нужен полный функционал

---

## Быстрый старт: десктоп в dev

```bash
cd voice-client && npm install && npm run build
cd ../desktop-client && npm install && npm run build && npm start
```

В приложении укажи адрес API бекенда (и при необходимости пароль сервера).

---

## Веб-UI (опционально)

Нужен запущенный backend. Переменная [`NEXT_PUBLIC_API_BASE`](.env.example) — базовый URL API **как его видит браузер** (не внутренний адрес Docker, если UI снаружи).

```bash
cp .env.example .env
# при необходимости поправь NEXT_PUBLIC_API_BASE

docker compose up --build
```

Открой `http://localhost:3000`. Electron по умолчанию использует уже собранный бандл в `desktop-client/ui`, а не этот dev-сервер.

---

## Сборка установщиков

Из каталога [`desktop-client/`](desktop-client):

| Команда | Назначение |
|---------|------------|
| `npm run dist` | Текущая ОС |
| `npm run dist:win` | Windows NSIS |
| `npm run dist:linux` | Linux AppImage / deb |
| `npm run dist:docker` | **Win NSIS + macOS zip** через Docker (с Linux/WSL) |

Кросс-сборка Win + mac из корня репозитория:

```bash
docker pull electronuserland/builder:wine
./desktop-client/scripts/docker-electron-build.sh
```

Артефакты попадают в `desktop-client/release/` (каталог обычно в `.gitignore`).

После правок в [`primer_front/`](primer_front) обнови встроенный UI:

```bash
cd desktop-client && npm run prepare:ui
```

---

## Ветки клиента

- **`macos`** — основная линия разработки клиента; от неё удобно делать merge в `windows` / `linux`.
- **`windows`** — клиент для релизов/правок под Windows (содержимое синхронизируй с `macos`, где это уместно).
- **`linux`** — при наличии: клиент под Linux.

Серверная часть **не** входит в эти ветки; см. ветку **`server`**.

---

## Возможности (клиент)

- Голос по UDP, статистика (потери, пинг, джиттер)
- Текстовые каналы, вложения
- Демонстрация экрана (WebSocket `screen_chunk`; на сервере должен быть relay)
- Настройки устройств, шумоподавление ОС, шумовой gate, Opus uplink (при поддержке сервера)
- Индивидуальная громкость участников голосового канала (настройки сохраняются локально; на сервере — взвешенный микс)

---

## Частые проблемы

| Симптом | Что проверить |
|--------|----------------|
| Пустой список микрофонов | Разрешения ОС на микрофон, перезапуск |
| Нет звука / обрывы | Firewall (TCP к API + UDP к медиа-порту), `PUBLIC_UDP_HOST` на сервере |
| Ошибка прав после Docker-сборки | Скрипт `docker-electron-build.sh` делает `chown`; либо `sudo chown -R "$USER:$USER" desktop-client/node_modules` |
| Смена сервера в голосе | Приложение переподключается; сессия голоса на предыдущем сервере завершается |

---

## Публикация на GitHub

Этот репозиторий можно зеркалировать или перенести на GitHub: добавь remote `origin` на GitHub и пушни ветки `macos`, `windows`, `server` (и при необходимости `linux`). Лицензию и `SECURITY.md` при желании положи в корень каждой «главной» ветки или используй один репозиторий с несколькими ветками, как сейчас.
