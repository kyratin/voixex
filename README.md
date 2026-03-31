# Voixex — backend

Ветка **`server`** содержит **только сервер**: REST API, WebSocket (чат, screen share relay), **UDP-микшер голоса**, SQLite, загрузки вложений. Образ публикуется в Docker Hub: [`kyratinkokko/voixex`](https://hub.docker.com/r/kyratinkokko/voixex).

Клиенты (**Electron**, Next UI, `voice-client`) — в ветках **`macos`** / **`windows`** (и при необходимости **`linux`**).

---

## Структура репозитория

| Путь | Назначение |
|------|------------|
| [`backend/`](backend) | Node.js (Fastify): HTTP, WS, медиа UDP, БД |
| [`docker-compose.yml`](docker-compose.yml) | Запуск готового образа + том для данных |
| [`scripts/build-push-backend.sh`](scripts/build-push-backend.sh) | Сборка образа из `backend/` и push в реестр |

---

## Быстрый старт (Docker)

```bash
cp .env.example .env
# Заполни TOKEN_SECRET, SUPERUSER_PASSWORD, PUBLIC_UDP_HOST (на VPS).

docker compose up -d
```

| Сервис | По умолчанию |
|--------|----------------|
| HTTP + WebSocket | `http://localhost:18080` (маппинг `HTTP_PORT` → 8080 в контейнере) |
| UDP голос | хост: `UDP_PORT` (по умолчанию **50000**), проброс 1:1 |

**Важно:** в `.env` на проде укажи **`PUBLIC_UDP_HOST`** — публичный IP или DNS машины. Клиенты открывают UDP на этот адрес; иначе голос не пройдёт через NAT/фаервол.

Открой на фаерволе **TCP** порт API (например 18080) и **UDP** `UDP_PORT`.

---

## Сборка образа и push (с ПК или CI)

Не собирай тяжёлый `docker build` на слабом VPS — лучше локально или в CI:

```bash
# Тег образа (совпадает с полем version в backend/package.json, например 0.1.9).
# Скрипт также пушит :latest тем же digest.
TAG=0.1.9 ./scripts/build-push-backend.sh
```

Предварительно: `docker login` (Docker Hub или другой реестр — поменяй образ в скрипте).

На сервере после пуша:

```bash
docker compose pull && docker compose up -d
```

Переопределение образа:

```bash
VOIP_BACKEND_IMAGE=kyratinkokko/voixex:0.1.9 docker compose up -d
```

---

## Запуск из исходников (без Docker)

```bash
cd backend
npm ci
npm run build
# задай переменные окружения (см. backend/src/config.ts и .env.example)
npm start
```

Удобно для отладки: `npm run dev` (tsx watch).

---

## Переменные окружения (выборочно)

Полный список — [`backend/src/config.ts`](backend/src/config.ts). Часто используемые:

| Переменная | Назначение |
|------------|------------|
| `PORT` | HTTP внутри контейнера (в compose проброшен как `HTTP_PORT`) |
| `UDP_PORT` | UDP медиа |
| `PUBLIC_UDP_HOST` | Что клиенты используют для UDP (должно быть достижимо из интернета на VPS) |
| `TOKEN_SECRET` | Подпись JWT/сессий — **смени в проде** |
| `SUPERUSER_PASSWORD` | Пароль суперпользователя |
| `DB_PATH` | SQLite (в Docker по умолчанию `/data/voip.sqlite`) |
| `UPLOAD_DIR` | Файлы вложений |
| `SCREEN_LOG` | `1` — логировать отладку screen relay |

---

## API и протоколы (кратко)

- **REST:** создание сервера, join, профиль, комнаты, сообщения, вложения.
- **WebSocket:** `GET /v1/ws?token=...` — чат, обновление ростеров, **`screen_chunk`** / демонстрация экрана.
- **UDP:** бинарные кадры (PCM16 и при поддержке клиента **Opus**), микшер по комнатам, лимиты по скорости.

Событие **`set_peer_volume`** задаёт индивидуальную громкость участника для конкретного слушателя (микширование на сервере).

---

## Публикация на GitHub

Можно зеркалировать репозиторий на GitHub и пушить ветку **`server`** отдельно — в ней нет клиентского кода, только backend и Docker-складка.

---

## Клиенты

Сборка десктопа и веб-UI описана в **README** веток `macos` / `windows`.
