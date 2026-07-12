# aglink-chat

Browser chat UI for [teleclaude](https://github.com/tyranno/teleclaude), split out into its own
service so UI/feature iteration doesn't require rebuilding or restarting teleclaude itself.

## Why a separate project

teleclaude's web chat (`web/`, `webchat.go`) currently lives inside the teleclaude binary,
embedded via `go:embed`. Every UI tweak — font size, a new button, a layout change — requires
rebuilding and restarting the whole teleclaude process, which also interrupts any in-flight
Telegram conversation. As the web UI grows, that coupling gets worse.

`aglink-chat` moves the browser-facing HTTP/WebSocket server and the `web/` UI into an
independently deployable process. teleclaude keeps owning all state and business logic
(`Bot`/`Manager`/`Hub`/`store`); `aglink-chat` becomes a thin, replaceable front door.

## Architecture

Unlike `aglink-screen`/`aglink-web` — which are MCP tool plugins a teleclaude **worker** spawns
per-turn over stdio — `aglink-chat` is a **long-running peer service**. It needs live, bidirectional
communication with teleclaude's `Hub`, not a one-shot tool call. The two talk over a small
**local-only control API**:

```
Browser  <--HTTP/WS-->  aglink-chat serve  <--control API (local WS)-->  teleclaude
(public, e.g. :1717)                        (loopback only, e.g. :17170)
```

- **teleclaude side**: exposes a loopback-only WebSocket control endpoint. Authenticates
  `aglink-chat` with the same shared-token mechanism the current `web_chat` config uses.
  Registers a new `ChannelSender` implementation (a "remote chat channel") with `Hub`, backed by
  this connection — the same role `telegramChannel`/`webChannel` play today, just over a socket
  instead of in-process calls.
- **aglink-chat side**: connects out to teleclaude's control API as a client (with reconnect/backoff,
  same pattern as `aglink-web`'s Chrome-extension keepalive), and serves the actual public-facing
  HTTP/WS + static `web/` UI to real browsers. Re-implements `/api/conversations` and `/api/upload`
  against the control API instead of calling into teleclaude's Go internals directly.

### Control-API protocol (draft — finalize during implementation)

Outbound (teleclaude → aglink-chat), one frame per event — mirrors today's `wsFrame`:
`{"type":"text"|"image"|"typing"|"done"|"user", ...}` (same fields as teleclaude's current
`web/app.js` already expects, so the browser-side rendering logic can move over unchanged).

Inbound (aglink-chat → teleclaude), request/response:
- `send_text {chatID, text, origin}` — equivalent of today's `dispatchText`.
- `handle_command {chatID, text, origin}` — equivalent of today's `handleCommand`.
- `list_conversations {}` → today's `/api/conversations` payload.
- `upload_attachment {chatID, path, caption}` — aglink-chat saves the multipart upload to disk
  itself and hands teleclaude the path (avoids streaming file bytes over the control API).

## Migration plan

1. **Scaffold** (this commit) — repo, `go.mod`, `aglink-chat serve` skeleton, this design doc.
2. **teleclaude: control-API server** — new file (e.g. `chatcontrol.go`), loopback WS endpoint,
   `remoteChatChannel` implementing `ChannelSender`, registered with `Hub` alongside
   `telegramChannel`. Config: `chat_control.enabled` / `chat_control.addr` (mirrors
   `screen_control`/`web_control` sections in `config.yaml`).
3. **aglink-chat: client + browser server** — connect to teleclaude's control API, port
   `web/index.html`/`app.js`/`style.css` over verbatim, reimplement `/api/conversations` and
   `/api/upload` against the control API.
4. **Cutover** — verify aglink-chat reaches full feature parity with teleclaude's embedded web
   chat (conversation list, origin-based web/telegram split, working indicator, cross-channel
   input echo — all recently added, see teleclaude's git history), then teleclaude drops
   `webchat.go`/`web/`. Wire `aglink-chat` into teleclaude's `!update` integrated-deploy
   (`pluginupdate.go`, same pattern as `aglink-screen`/`aglink-web`).

## teleclaude와 연결

teleclaude가 `aglink-chat serve`를 **자식 프로세스로 관리**(supervise)합니다 — 직접 실행할 필요 없이,
teleclaude를 켜면 아래 설정에 따라 자동으로 띄우고 control API로 연결합니다.

### 1. 설정 (`~/.teleclaude/config.yaml`)

```yaml
aglink_chat:
  enabled: true          # 이거 하나면 control API(chat_control)도 자동 활성화됨
  addr: "127.0.0.1:1717" # 브라우저 UI 주소 (기본값)
  binary_path: ""        # 비우면 teleclaude.exe 옆 또는 ../aglink-chat/ 에서 자동 탐지
```

> `aglink_chat.enabled: true`는 control API를 자동으로 함의합니다. (이전에는 `chat_control.enabled`도
> 따로 켜야 했고, 하나만 켜면 조용히 아무것도 안 떴습니다.) 제어 주소/토큰을 바꾸려면 `chat_control:`
> 섹션을 별도로 지정하면 되고, 아니면 기본값(`127.0.0.1:17170`, 토큰 자동 생성)이 쓰입니다.

### 2. 배치 (자동 탐지 순서)

`aglink-chat(.exe)`를 다음 중 한 곳에 두면 `binary_path` 없이 인식됩니다:

1. `binary_path`로 지정한 경로
2. **teleclaude 실행파일과 같은 폴더** (`!update` 통합 배포가 놓는 위치)
3. **형제 소스 저장소** `../aglink-chat/` (dev 체크아웃)
4. `PATH`

### 3. 토큰

- **control 토큰**: `~/.teleclaude/chat_control.token` (없으면 teleclaude가 생성). teleclaude가
  `--control-token`으로 직접 넘겨주므로 보통 신경 쓸 필요 없습니다.
- **브라우저 토큰**: `~/.teleclaude/web_chat.token` (재사용 — 이미 열린 탭이 재연결됨). 접속 URL은
  기동 로그에 `http://127.0.0.1:1717/?token=...` 형태로 출력됩니다.

### 4. 텔레그램 없이 웹채팅만 (선택)

`telegram.bot_token`을 비워두면 teleclaude가 **웹채팅 전용 모드**로 부팅합니다(텔레그램 폴링 없음).
`allowed_user_ids`는 최소 1개 필요합니다(웹 소유자 식별용).

### 5. 재배포 (`!update` / redeploy-plugin.ps1)

teleclaude와 aglink-chat을 형제 폴더로 두면, teleclaude의 `!update`가 aglink-chat을 먼저 빌드해
teleclaude.exe 옆에 배치한 뒤 재기동합니다. 수동으로는 teleclaude 저장소의
`scripts/redeploy-plugin.ps1 -Name aglink-chat`을 쓰세요(빌드→종료→복사→재기동 확인).

`aglink-chat`은 `SIGINT`/`SIGTERM`에 graceful shutdown 하므로(진행 중 요청 드레이닝 후 종료),
`!update`가 `.exe` 잠금을 즉시 놓아주고 supervisor가 새 바이너리로 깔끔히 재기동합니다.
