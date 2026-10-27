# Voixex — UI brief for v0.dev

## Как пользоваться (для нас)

1. Откройте новый чат в [v0.dev](https://v0.dev). Вставьте целиком разделы **1–4** (контекст, ограничения, дизайн, раскладка), затем **один** экран из раздела **5**, затем шаблон из раздела **8**. Один экран — один чат: так v0 не путается и не переписывает всё сразу.
2. Приложите скриншот текущего экрана из клиента — v0 лучше понимает, что улучшать.
3. Попросите вернуть **полный файл** компонента с тем же именем и теми же пропсами (раздел 7).
4. Перенесите файл в `primer_front/components/voip/…`, добавьте новые ключи переводов во все 4 локали (`lib/i18n/locales/{en,ru,es,pt}.ts`), проверьте:
   ```bash
   cd primer_front && npx tsc --noEmit -p tsconfig.json && npm run build
   ```
5. Сверьтесь с чек-листом из раздела 9 и только потом собирайте клиент.

---

## 1. Product context

**Voixex** is a desktop voice + text chat (Electron app, Next.js UI) for small private groups. Everything is **self-hosted**:

- There are **no global accounts**. Each server is a **closed space** run by its owner. You see nothing of a server (name, channels, members) until you sign in.
- The client is connected to **one server at a time**. Switching servers fully disconnects from the previous one.
- On the first visit you enter the **server password** once, pick a **nick for that server**, and choose a **protection level**:
  1. **Password** — nick + personal password, from any device.
  2. **Certificate** — this device gets a certificate, one-click sign-in.
  3. **Password + certificate** — both.
  The server admin can require a **minimum level**. The server connection itself is **HTTPS** or plain **HTTP** (shown as a badge).
- Inside a server: text channels (chat with attachments) and voice channels (voice + screen sharing via LiveKit/WebRTC or a legacy UDP path).
- Users: small groups (2–50 people), often in voice for hours, sharing screens.

The UI languages are **English, Russian, Spanish, Portuguese**. **Russian is the main one** and its strings are ~30% longer than English.

## 2. Tech stack and hard constraints

| Area | Constraint |
|---|---|
| Framework | Next.js 16 App Router, **static export** (`output: "export"`, `assetPrefix: "./"`). No API routes, no server actions, no `next/image` optimization, **no `next/font`** (it breaks with a relative asset prefix). All UI components are `"use client"`. |
| Runtime | Runs inside Electron from a custom protocol, **offline-capable**: no external fonts, CDNs or remote images. |
| React / TS | React 19, TypeScript (strict types; the build must pass `tsc --noEmit`). |
| Styling | **Tailwind CSS v4** (CSS-first, tokens declared with `@theme inline` in `app/globals.css`), `tw-animate-css`, helper `cn()` from `@/lib/utils`. |
| Components | **shadcn/ui, style "new-york"**, already in `components/ui`: accordion, alert, alert-dialog, avatar, badge, button, button-group, card, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, empty, field, hover-card, input, input-group, item, kbd, label, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip. Use these; **do not add new npm packages**. |
| Icons | `lucide-react` only. |
| Toasts | `sonner` (`toast.success / toast.error`). |
| Theme | **Dark only** (the `<html>` has class `dark`). |
| Text | Every visible string goes through i18n: `const { t } = useI18n()` from `@/lib/i18n/provider`, e.g. `t("chat.messagePlaceholder", { channel })`. Never hard-code UI text. For new strings, list the new keys with **en and ru** values (we add es/pt). |
| Colours | **Only theme tokens** (table in section 3). No hex/rgb values in components, no new colour scales. Status colours allowed: `bg-amber-400` (idle), `text-yellow-500` (fair quality). |
| Avatars | Initials on a gradient: `avatarGradient(seed)` from `@/lib/avatar-colors`, used as `style={{ background: avatarGradient(user.id) }}`. Keep it — there are no uploaded avatars. |
| Window | Minimum window width ≈ **960 px**. Channel sidebar **240 px**, member list **240 px**. Nothing may require horizontal scrolling at 960 px. |

## 3. Design language

The look follows Fluxer/Discord-like apps: **surfaces step up in tone instead of borders**, soft radii, indigo accent, green for "live/voice/online".

| Token (Tailwind class) | Value | Used for |
|---|---|---|
| `bg-sidebar` | `#0f0f14` | darkest: user panel card, server list header strip |
| `bg-card` | `#131319` | channel sidebar, member list, cards on the home screen |
| `bg-background` | `#1a1a20` | main content (chat, home) |
| `bg-secondary` / `bg-muted` / `bg-input` | `#212127` | inputs, chips, secondary buttons |
| `bg-sidebar-accent` | `#28282e` | hover and selected rows |
| `bg-popover` | `#18181d` | menus, popovers, dialogs |
| `bg-stage` | `#08080a` | voice/stream stage behind video |
| `text-foreground` / `text-muted-foreground` | `#e5e5e9` / `#9494a1` | text |
| `bg-primary` / `ring-ring` | `#4641d9` / `#6f6bf2` | main actions, focus ring, selected level |
| `text-accent` / `bg-accent` | `#23a55a` | voice connected, online, speaking ring, HTTPS badge |
| `text-destructive` | `#e5484d` | leave, errors, LIVE badge, muted |
| `border-border` | `#2a2a31` | only where a separator is really needed |
| radius | `rounded-lg` (0.5rem), `rounded-xl` for cards/tiles | |

Typography: **Radio Canada Big** with **Noto Sans** fallback (Cyrillic) are already loaded in CSS — just use `font-sans`. Base size 14–15 px, headings 15–24 px semibold/bold.

Principles:
- Hierarchy through **tone and spacing**, not lines. Avoid `border` except for dialogs and form inputs.
- **Density** of a chat app: rows 32–40 px, but generous hit targets (≥ 32 px) for icon buttons.
- Voice state must be readable at a glance: who is speaking (green ring), muted/deafened icons, who is **LIVE** (red badge).
- Quality colours: `text-accent` good / `text-yellow-500` fair / `text-destructive` bad (computed in the app, passed as `qualityClass`).
- Motion: subtle (150–200 ms colour/opacity/scale), no layout jumps.
- Every icon-only button has `aria-label` and a `Tooltip`. Visible focus ring (`focus-visible:ring-2 ring-ring`).

## 4. Layout map

**Server list** (not connected to any server):

```
┌──────────────────────────────────────────────────────────┐
│ Voixex                                  ⚙ Device settings │
│ My servers                    [Import certificate] [+ Add]│
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│ │ (V) label    │ │ (W) label    │ │ ...          │        │
│ │ host:port    │ │ host:port    │                         │
│ │ HTTPS · L3   │ │ HTTP · needs │                         │
│ │ ● online     │ │ ○ offline    │                         │
│ └──────────────┘ └──────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

**Inside a server**:

```
┌───────────────┬───────────────────────────────┬────────────┐
│ ← My servers  │ # channel            [members] │ Members    │
│ HTTPS · L3    │                               │ Online — 3 │
│ Server name   │  messages / voice stage       │  (A) Alice │
│ Text          │                               │  (B) Bob   │
│  # general    │                               │ Offline — 1│
│ Voice         │                               │            │
│  🔊 Lobby     │                               │            │
│    (K) Kyr 🔴 │                               │            │
│───────────────│                               │            │
│ Voice conn. ▸ │                               │            │
│ (K) Kyr 🎤🎧⚙ │ [ Message #general         ]  │            │
└───────────────┴───────────────────────────────┴────────────┘
   240 px              flexible                    240 px
```

## 5. Screens and tasks

Each task names the file, the **contract to keep** and what to improve. Keep exported names and props; you may **add optional props** (say so explicitly in the answer).

### 5.1 Server list — `components/voip/server-home.tsx`

Contract:

```ts
export type ServerCardInfo = {
  id: string; label: string; address: string; secure: boolean
  authMode: "password" | "certificate" | "password_certificate" | null // null = not protected yet
  reachable: "unknown" | "online" | "offline"
}
interface ServerHomeProps {
  servers: ServerCardInfo[]; busyServerId: string | null
  onOpen(id: string): void; onAdd(): void; onImport(): void
  onSignInAsAdmin(id: string): void; onEdit(id: string): void; onRemove(id: string): void
  onOpenDeviceSettings(): void
}
```

Reuse `ConnectionSecurityBadge` from `./server-access-dialog` for HTTPS/HTTP. Level names come from `t("levels.password")`, `t("levels.certificate")`, `t("levels.password_certificate")`; short form `t("levels.short", { level, name })`.

Improve:
- Stronger card hierarchy: label first, address secondary, a compact status row (connection badge, protection level, reachability).
- Clear states: busy (signing in), offline (dimmed, still clickable), "needs protection" (amber call to action).
- Empty state with a short explanation of "closed servers" and the two entry points (Add / Import certificate).
- Card actions menu stays (edit connection, sign in with superuser password, remove). Whole card is a button; full keyboard support.

### 5.2 Channel sidebar and user panel — `channel-sidebar.tsx`, `user-panel.tsx`

Contracts: `ChannelSidebarProps` (server name, optional `security: { secure, levelLabel }`, `onLeaveServer`, categories of text/voice channels, `voiceUsers` per voice channel with `isSpeaking / isMuted / isDeafened / isScreenSharing / isWatchingScreen`, per-user volume popover). `UserPanelProps` (user, mute/deafen toggles, `isInVoice`, `voiceChannelName`, `voiceStatsSummary`, `qualityClass`, `onDisconnect`, `onOpenSettings`, stats popover).

Known problems to fix:
- At 240 px the user panel **truncates the nick and status to "K…" / "Onl…"**. Rebalance: avatar + name block must keep at least ~110 px; icon buttons can be 28 px.
- The voice block ("Voice connected · channel · Ping 159 ms · loss 0%" + Leave) must fit Russian text ("Голос подключён", "Пинг 159 мс · потери 0%") without cutting the leave button.
- Header area: back link "My servers", the security line, server name/banner — make it one compact, tidy header.
- Voice users under a voice channel: speaking ring, LIVE badge, muted/deafened icons, hover for the volume popover.
- There must be **one** leave control (in the user panel) — do not add another.

### 5.3 Chat — `chat-area.tsx`

Contract: `Message` (author, content, timestamp, edited flag, reactions, attachments with `mime`/`url`/`sizeBytes`) and `ChatAreaProps` (`channelName`, `messages`, `onSendMessage`, optional `onUploadAttachment`, member-list toggle, `canSend`).

Improve:
- **Group consecutive messages** of the same author within 5 minutes (avatar + name only on the first; hover shows time on the others).
- **Date separators** ("Today", "Yesterday", date).
- Attachments: image thumbnails in a neat grid with max size, video/audio players, file chips with name + size.
- Composer: auto-growing `Textarea` (Enter sends, Shift+Enter new line), attach button, disabled state with the reason (`t("chat.messagingDisabled")`).
- Keep the "jump to bottom on new message" behaviour.

### 5.4 Voice channel and screen sharing — `voice-channel-view.tsx`

Contract: `VoiceChannelViewProps` (see the file; ~40 props). **Must keep**: `localPreviewVideoRef` and `remoteStreamVideoRef` bound to `<video>` elements (WebRTC/MSE attach to them), all screen-share settings (source, resolution, FPS, bitrate, system audio), pop-out, fullscreen, hide/show stream, stream volume (`StreamVolumeControl`), join/leave.

Today the view is stream-centric with many buttons in the header. Goal:
- A **stage** on `bg-stage`: the stream when someone shares; otherwise a **participant tile grid**. Add an optional prop `participants?: { id; name; isSpeaking?; isMuted?; isDeafened?; isScreenSharing? }[]` (we will pass the voice users of the channel). Tiles: gradient avatar, speaking ring, name pill, muted icon, LIVE badge.
- A **floating control dock** at the bottom: share screen (with a chevron/popover for quality settings), system audio toggle, pop-out, fullscreen, hide stream, member list toggle. Mute/deafen/leave stay in the user panel — do not duplicate them.
- Loading and "stream hidden" states that do not shift the layout.

### 5.5 Member list — `member-list.tsx`

Contract: `Member` (`status: online | idle | dnd | offline`, optional `activity`, `isOwner`, `isBot`), `MemberListProps`.
Improve: grouped headers with counts, status dot, dimmed offline members, optional `HoverCard` with name/status. Width 240 px.

### 5.6 Sign-in dialog — `server-access-dialog.tsx`

Contains the sign-in / registration / claim / "raise protection" flows and exports `ProtectionLevelPicker` and `ConnectionSecurityBadge`. **Logic must stay exactly as is** (modes, validation, error handling, steps "server → protection"). Only restyle:
- Level picker: three cards with an icon each (key / shield / shield+key), level number, short description, disabled state "below the server minimum", selected state in `primary`.
- HTTP warning (`levels.httpPasswordWarning`) clearly visible but calm (amber).
- Two-step "Add server" flow with a small step indicator.

### 5.7 Settings — currently inline in `app/page.tsx`

The settings dialog is ~400 lines inside `app/page.tsx` (tabs: Language, Voice, Keybinds, My profile here, Server, Channels, Roles, Members). Task: propose a **`SettingsDialog` component** with a left navigation (two groups: *This device* — language, voice, keybinds; *This server* — my profile, server, channels, roles, members) and well-structured sections. The **Voice** tab is long: group it into cards *Devices*, *Volume*, *Processing* (noise suppression, echo cancellation, AGC, Speex), *Noise gate* (with the mic meter), *Playback DSP*, *Monitor*. All state stays in `page.tsx`; the component only receives values and callbacks.

## 6. Do not change

- State, effects and data flow in `app/page.tsx`, `lib/voip-client.ts`, `lib/webrtc-media.ts`, the Electron bridge (`window.electronVoice`, `window.voixexIdentity`).
- i18n provider and existing translation keys (you may add keys).
- `globals.css` tokens (propose changes separately if really needed).
- Behaviour: one leave control; mic test works from Voice settings; level-2 servers sign in with one click.

## 7. Expected output from v0

1. The **complete file** for each changed component, same path and export names, props unchanged (new props optional and listed).
2. A list of **new i18n keys** with `en` and `ru` values, in the form `section.key: "English" / "Русский"`.
3. No mock data inside components. If a preview needs data, put it in a separate `*.preview.tsx` file.
4. A short note of anything that needs a change outside the file (e.g. a new optional prop to pass from `page.tsx`).

## 8. Prompt template (paste after sections 1–4 and one screen from section 5)

```text
You are improving one screen of the Voixex desktop app UI. Follow the constraints above strictly:
Next.js static export, Tailwind v4 theme tokens only, shadcn/ui new-york components that already
exist, lucide-react icons, dark theme only, every string through t() from useI18n, no new npm
packages, keep the component's exported name and props.

Screen: <name and file from section 5>
Current screenshot: attached.
Goals: <copy the "Improve" bullets>

Return:
1) the complete updated file,
2) new i18n keys with en and ru values,
3) any optional props you added and where they come from.
Design for a 960 px wide window and Russian strings (~30% longer than English).
```

## 9. Acceptance checklist

- [ ] `npx tsc --noEmit -p tsconfig.json` and `npm run build` pass in `primer_front`.
- [ ] No hex/rgb colours in the component; only theme tokens (section 3).
- [ ] No new dependencies in `package.json`.
- [ ] All visible text uses `t()`; new keys added to en/ru/es/pt.
- [ ] Russian UI at 960 px: nothing important truncated (nick, "Голос подключён", buttons).
- [ ] Icon buttons have `aria-label` + tooltip; focus ring visible; keyboard works.
- [ ] Props contract unchanged; `page.tsx` still compiles without edits (or the needed edits are listed).
- [ ] Voice: refs still attached to `<video>`, one leave control, speaking/muted/LIVE states visible.
