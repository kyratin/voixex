# 0.7.3 — Fix progressive voice loss

- Fix Opus WASM scratch-buffer allocation/addressing that could corrupt neighbouring codecs during participant churn and packet-loss concealment, eventually stopping voice or crashing the media worker.
- Keep compatible audio until all expected WebRTC microphone tracks are playable; reconnecting/missing/paused tracks fall back instead of silencing the room.
- Publish a clone of the processed microphone so mode switches cannot stop the source used by compatible voice. Make microphone publication race-safe and remote audio attachment idempotent.
- Server reports codec failures and counts transmitted voice frames only when packets were actually sent, with PCM fallback if encoding fails.
- Tests cover three simultaneous speakers, camera traffic, packet loss, mute, transport changes, codec churn, and real three-party WebRTC audio. Server and desktop clients must both be updated for the codec fix.

# 0.7.2 — Call layout, speaking indicator and connection settings

- Participant tiles fill the available call area. One participant fills the grid; up to 12 participants form a grid of at most 4 columns × 3 rows, with pages for larger channels.
- The bottom avatar ring follows post-DSP microphone loudness instead of sent-packet counts. Silence, mute, leaving and stalled capture clear the ring; the online status dot remains independent.
- Voice settings distinguish Voixex UDP/TCP/WebSocket from WebRTC's automatic ICE negotiation. Compatibility/fallback transport settings have their own expandable section; WebSocket uses the API port.
- Client-only update: server 0.7.1 remains compatible; no server deployment is required.

# 0.7.1 — Smoother compatibility camera video

- Raise the compatibility camera target from 8 to 30 fps, keeping the maximum width at 480 pixels.
- Account for encoding and sending time in frame scheduling; yield between small packet batches instead of delaying every packet.
- Server 0.7.1 raises the camera sender budget to 1 MiB/s. Actual frame rate still depends on camera, CPU and network conditions.

# 0.7.0 — Cameras in voice channels

- Camera controls, local preview, participant video and device selection on Android, macOS and Windows.
- Camera media over UDP, TCP and WebSocket; native Android UDP/TCP sockets and explicit desktop WebSocket selection.
- LiveKit camera tracks coexist with screen share. Compatibility JPEG video also runs so participants on different transports can see one another.
- Independent channel camera permission, server capability detection, bounded packet/frame assembly and cleanup when leaving or backgrounding.
- Legacy video is up to 480px wide / 8 fps; WebRTC requests 720p / 30 fps. The compatibility stream adds upload bandwidth when LiveKit is active.
- Requires server 0.7.0+ for cameras. See docs/camera.md for tests and limitations.

# Changelog — desktop client (0.2.15 → 0.2.21)

Единый список изменений **по порядку** (от более ранних к более поздним). Версии в скобках — когда изменение вошло в релизный номер пакета.

1. **(0.2.15)** Публикация клиентских сборок **0.2.15**.
2. **(0.2.15)** Список участников голосового канала **стабилен** и отсортирован **по алфавиту** — порядок не прыгает, когда кто-то начинает говорить.
3. **(0.2.15 → 0.2.18)** Полировка голосового UI и брендинга в приложении.
4. **(до 0.2.18)** В репозиторий добавлена лицензия **MIT**; README обновлялся под открытую публикацию.
5. **(0.2.18)** **Opus uplink** включён **по умолчанию** (если IPC поддерживает) — меньше трафика и привычное качество вместо сырого PCM.
6. **(0.2.18)** Входящий голос: **jitter-буфер**, воспроизведение через **AudioWorklet**, **кубическая интерполяция** при ресэмпле downlink (`voice-resample`).
7. **(0.2.18)** Совместимость с сервером: на backend нормализован формат PCM под стабильный размер кадра (рекомендуемый образ **`kyratinkokko/voixex:0.1.14`** и новее).
8. **(0.2.18)** Обновлён встроенный статический UI Next.js в Electron (`prepare:ui` → `desktop-client/ui`).
9. **(0.2.19)** Номер версии **0.2.19**; подготовка установщиков под Windows / Linux / macOS.
10. **(0.2.19)** Опциональный **Speex DSP** в цепочке захвата: `speex.wasm`, `speex-worklet.js`, скрипт копирования в `public/`, модуль `speex-capture.ts`, зависимость **`@sapphi-red/web-noise-suppressor`** — включается в настройках, не навязан постоянно.
11. **(0.2.20)** Версия **0.2.20**; синхронизация экспорта Next.js и релизных артефактов.
12. **(0.2.20)** Скрипт **Docker** (`docker-electron-build.sh`): для `electronuserland/builder:wine` задана платформа **`linux/amd64`**, чтобы кросс-сборка на Apple Silicon не ломала исполняемые файлы.
13. **(0.2.20)** В Docker для **macOS** собирается **zip**; **DMG** — отдельно на macOS командой `npm run dist:mac` (DMG из Linux-контейнера нестабилен). README: таблица `dist:docker` уточнена.
14. **(0.2.21)** Версия **0.2.21**.
15. **(0.2.21)** Speex **по умолчанию выключен** — шумодав браузера (WebRTC) обычно звучит естественнее; Speex остаётся опцией в настройках.
16. **(0.2.21)** Воспроизведение входящего аудио: данные уходят **напрямую в AudioWorklet** (кольцевой буфер на аудиопотоке), без периодического дренажа через `setInterval` в JS — меньше джиттера и артефактов по тону.
17. **(0.2.21)** **Opus:** битрейт **64 kb/s**, повышенная сложность кодирования, **FEC** и подсказка по потерям пакетов.
18. **(0.2.21)** High-pass на захвате **~75 Hz** вместо 110 Hz — меньше излишнего среза низов речи.
19. **(0.2.21)** **Noise Gate (uplink):** огибающая **сохраняется между кадрами** (слабее «пампинг» на чувствительных микрофонах); по умолчанию гейт **выключен**; текст подсказок в UI обновлён.

---

**Backend:** для согласованного голоса через сервер рекомендуется образ **не ниже 0.1.14** (ветка **`server`**, см. основной README).
