# RDP Web Player — Design Spec

## Problem Statement

Teleport's RDP session playback for interview reviews has four pain points:

1. **No zoom** — candidate screens vary in resolution; the player can't scale, making high-res recordings hard to read
2. **Crash on corrupt data** — a few seconds of damaged recording data causes tp-player to exit; reviewers must restart and manually skip past the corruption
3. **Not native on macOS** — tp-player is a Qt app, non-native feel on macOS
4. **Flaky startup** — sometimes TP-Assist is running but playback won't launch until the user closes the browser, reopens it, and re-triggers from the server UI

## Constraint

**Only client-side code can be modified.** The Teleport server (Python backend, web routes) is off-limits.

## Solution

Replace the desktop Qt player (`tp-player`) with a **browser-based RDP recording player** built as a standalone HTML + JS application. It uses the server's existing `/audit/get-file` API (which serves raw binary recording files) and parses the new binary format (`.tpr`/`.tpk`/`.tpd`) entirely in JavaScript.

This eliminates the need for TP-Assist, tp-player.app, and any native installation.

## Architecture

### Data Flow

```
Browser Player
    │
    ├─ fetch /audit/get-file?f=tp-rdp.tpr  → Parse header (resolution, duration, .tpd count)
    ├─ fetch /audit/get-file?f=tp-rdp.tpk  → Parse keyframe index (for seek)
    └─ fetch /audit/get-file?f=tp-rdp-N.tpd → Stream-download data packets
          │
          ▼
    JS Binary Parser (DataView / ArrayBuffer)
          │
          ├─ 0x13 RDP_IMAGE  → RLE decompress (rle.js WASM) → Canvas putImageData
          ├─ 0x12 RDP_POINTER → Draw cursor overlay
          └─ 0x14 RDP_KEYFRAME → zlib decompress → Full-screen render (seek target)
```

### File Structure

```
client/tp-player-web/
├── index.html          # Main page
├── css/
│   └── player.css      # Player styles
├── js/
│   ├── app.js          # Entry point, UI controls
│   ├── downloader.js   # fetch-based .tpr/.tpk/.tpd downloader
│   ├── parser.js       # Binary format parsing (DataView)
│   ├── decoder.js      # RLE decompression + zlib decompression
│   └── renderer.js     # Canvas rendering + zoom
└── lib/
    └── rle.js          # Existing Emscripten WASM module (copied from server)
```

## Binary Format Parsing

All multi-byte fields are little-endian.

### `.tpr` Header (512 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 4 | magic | `0x52505054` ("TPPR") |
| 4 | 2 | ver | Must be `4` |
| 6 | 2 | type | `0x0101` = RDP |
| 8 | 4 | time_ms | Total duration in ms |
| 12 | 4 | dat_file_count | Number of `.tpd` files |
| 16–63 | 48 | _padding | Reserved |
| 64 | 2 | protocol_type | `1` = RDP |
| 66 | 2 | protocol_sub_type | `100` = RDP-DESKTOP |
| 68 | 8 | timestamp | UTC start time (seconds) |
| 76 | 2 | width | Initial screen width |
| 78 | 2 | height | Initial screen height |
| 80 | 64 | user_username | Teleport login user (UTF-8) |
| 144 | 64 | acc_username | Remote account (UTF-8) |
| 208 | 40 | host_ip | Remote host IP |
| 248 | 40 | conn_ip | Connected IP |
| 288 | 2 | conn_port | Remote port |
| 290 | 40 | client_ip | Client IP |

### `.tpk` Keyframe Index (12 bytes each)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | time_ms |
| 4 | 4 | file_index |
| 8 | 4 | offset |

### `.tpd` Packet Stream

Each packet: 12-byte header + payload.

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | type |
| 1 | 4 | size (payload bytes) |
| 5 | 4 | time_ms |
| 9 | 3 | _reserve |

**Packet types:**

- `0x12` (`RDP_POINTER`): `{ x: uint16, y: uint16, button: uint8, pressed: uint8 }`
- `0x13` (`RDP_IMAGE`): `{ count: uint16, images: [{ destLeft, destTop, destRight, destBottom, width, height, bpp, format, compressed_size, raw_size, data }...] }`
  - format `0` = raw pixels, `1` = RLE compressed bitmap, `2` = cache back-reference
- `0x14` (`RDP_KEYFRAME`): `{ keyframe_info: 12B, pixels: zlib-compressed width*height*2 bytes (16-bit RGB) }`

## Fault Tolerance

1. Each `TS_RECORD_PKG` is parsed independently in a try-catch
2. On parse failure: if `size` field is plausible (≤ remaining file bytes), skip `size` bytes and continue; otherwise scan forward byte-by-byte for the next valid packet header
3. Corrupted time ranges are recorded in `corruptedRanges[]` and shown as red marks on the progress bar
4. Playback never stops due to data corruption — damaged frames are silently skipped

## Rendering

- **Off-screen canvas** as frame buffer (size = recording width × height)
- Image update packets → RLE/zlib decompress → `putImageData()` to frame buffer rect
- Keyframe packets → zlib decompress → full frame write
- `requestAnimationFrame` copies frame buffer to display canvas
- Mouse cursor rendered as a red dot overlay on the frame buffer

## Zoom & Pan

- CSS `transform: scale()` + `transform-origin` on the canvas container
- `Ctrl + scroll wheel`: zoom in/out (25% steps, range 25%–400%)
- Buttons: "Fit Window" (auto-scale to fill), "1:1" (original size), "+", "−"
- Click-drag to pan when zoomed in

## Playback Controls

- **Bottom control bar**: play/pause, progress bar (draggable), time display, speed selector (1×/2×/4×/8×/16×), skip-silence toggle
- **Progress bar seek**: uses `.tpk` keyframe index — find nearest keyframe before target time, render it, then fast-forward through packets to target
- **Corrupted regions** shown as red segments on the progress bar
- **Keyboard shortcuts**: Space = play/pause, ←/→ = ±10s, +/− = speed up/down

## UI Layout

```
┌─────────────────────────────────────────┐
│  [← Back]  RDP Replay — user@host       │  ← Top bar (metadata)
├─────────────────────────────────────────┤
│                                         │
│         ┌───────────────┐               │
│         │               │               │  ← Canvas area
│         │  Recording    │               │     (zoomable, pannable)
│         │               │               │
│         └───────────────┘               │
│                                         │
├─────────────────────────────────────────┤
│ ▶ ──●───────────── 05:32/15:20  1x ▼   │  ← Control bar
│ [Fit] [1:1] [+] [-]  Zoom: 75%         │
└─────────────────────────────────────────┘
```

## Loading Strategy

1. Download `.tpr` (512B) and `.tpk` (a few KB) first — instant
2. Download first `.tpd` file, begin playback immediately
3. Remaining `.tpd` files preload in background
4. Seeking to an un-downloaded region triggers priority download of that `.tpd` file
5. Show download progress indicator

## Deployment

Since server code cannot be modified, the player is deployed as static files:

**Primary method**: Copy `tp-player-web/` to the Teleport server's static directory (e.g., `/opt/teleport/data/www/teleport/static/tp-player-web/`). Access via `https://{server}/static/tp-player-web/index.html?rid=123`.

**CORS**: Same-origin deployment avoids CORS issues entirely. Browser cookies (`_sid`) are sent automatically for `/audit/get-file` authentication.

**Fallback**: Host separately with nginx reverse proxy adding CORS headers (no server code change needed).

## Technology Stack

- Pure HTML + CSS + Vanilla JS (no build tools, no framework)
- `rle.js` — existing Emscripten WASM module for RLE bitmap decompression (copied from server static assets)
- `DecompressionStream('deflate')` or pako.js for zlib decompression
- fetch API with `credentials: 'include'` for authenticated binary downloads

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Network error | Retry 3×, then show error with retry button |
| Auth expired (`_sid` invalid) | Prompt to re-login, link to login page |
| Unsupported format (magic/ver mismatch) | Clear error message with format details |
| Corrupt frames | Skip + mark on progress bar, continue playback |
| `.tpd` file missing on server | Skip file, show warning, continue with available data |

## How This Solves Each Problem

| Problem | Solution |
|---------|----------|
| 1. No zoom | CSS transform scaling (25%–400%) + fit-to-window + drag-to-pan |
| 2. Crash on corrupt data | Per-packet try-catch, skip corrupt frames, never stop playback |
| 3. Not native on macOS | Browser-based, works on any OS |
| 4. Flaky startup | No TP-Assist dependency, direct URL access |
