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
    │  All API calls use: /audit/get-file?act=read&type=rdp&rid={rid}&f={filename}
    │  File size query:   /audit/get-file?act=size&type=rdp&rid={rid}&f={filename}
    │
    ├─ fetch ...&f=tp-rdp.tpr     → Parse header (resolution, duration, .tpd count)
    ├─ fetch ...&f=tp-rdp.tpk     → Parse keyframe index (for seek)
    └─ fetch ...&f=tp-rdp-N.tpd   → Stream-download data packets (N is 1-indexed)
          │
          ▼
    JS Binary Parser (DataView / ArrayBuffer, little-endian)
          │
          ├─ 0x13 RDP_IMAGE    → zlib decompress (if zip_len>0) → RLE decompress (if format=1) → Canvas putImageData
          │                      format=2 (TS_RDP_IMG_ALT): look up image cache by index, no pixel data in packet
          ├─ 0x12 RDP_POINTER  → Draw cursor overlay
          └─ 0x14 RDP_KEYFRAME → zlib decompress → RGB565/RGB555 → RGBA → Full-screen render
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

All multi-byte fields are little-endian. Every `DataView.getUint16()` / `getUint32()` call must pass `true` as the `littleEndian` parameter.

### Server API: `/audit/get-file`

All file access uses the existing server endpoint with **four required parameters**:

```
GET /audit/get-file?act={act}&type=rdp&rid={record_id}&f={filename}
```

| Parameter | Values | Description |
|-----------|--------|-------------|
| `act` | `size` or `read` | `size` returns file size as integer string; `read` streams file content |
| `type` | `rdp` | Recording type |
| `rid` | integer | Record ID |
| `f` | filename | e.g., `tp-rdp.tpr`, `tp-rdp.tpk`, `tp-rdp-1.tpd` |

For `read`, optional `offset` and `length` parameters support partial reads. Server returns HTTP 416 if `offset >= file_size`.

Authentication: requires `_sid` cookie (sent automatically via `credentials: 'include'` on same-origin).

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
- `0x13` (`RDP_IMAGE`): `{ count: uint16 }` followed by `count` image entries, each:

  **`TS_RECORD_RDP_IMAGE_INFO` struct (24 bytes):**
  | Offset | Size | Field |
  |--------|------|-------|
  | 0 | 2 | destLeft |
  | 2 | 2 | destTop |
  | 4 | 2 | destRight |
  | 6 | 2 | destBottom |
  | 8 | 2 | width |
  | 10 | 2 | height |
  | 12 | 2 | bitsPerPixel (15 or 16) |
  | 14 | 1 | format |
  | 15 | 1 | _reserved |
  | 16 | 4 | dat_len (raw/uncompressed data length) |
  | 20 | 4 | zip_len (compressed length; 0 = not compressed) |

  Followed by `zip_len > 0 ? zip_len : dat_len` bytes of image data.

  **Format values:**
  - `0` (`TS_RDP_IMG_RAW`): Raw pixels, `dat_len` bytes of pixel data
  - `1` (`TS_RDP_IMG_BMP`): RLE-compressed bitmap — first zlib decompress (if `zip_len > 0`), then RLE decompress using `rle.js` WASM `bitmap_decompress_15()` or `bitmap_decompress_16()` based on `bitsPerPixel`
  - `2` (`TS_RDP_IMG_ALT`): Cache back-reference — `dat_len` is repurposed as a cache index into previously decoded images; **no pixel data follows** in the packet payload

  **Two-layer decompression for format 1:**
  1. If `zip_len > 0`: zlib decompress the `zip_len` bytes → produces `dat_len` bytes
  2. RLE bitmap decompress the result → produces `width * height * 4` RGBA pixels

- `0x14` (`RDP_KEYFRAME`): `{ keyframe_info: 12B, pixels: zlib-compressed width*height*2 bytes }`
  - Pixel format: RGB565 (5-bit R, 6-bit G, 5-bit B) or RGB555 (5-5-5) — must convert to RGBA for `putImageData()`

### Image Cache Mechanism

RDP bitmap updates frequently use cache references (format `2`) to avoid retransmitting unchanged screen regions.

Implementation:
- Maintain an array `imageCache[]` of previously decoded image data (raw RGBA pixels + rect info)
- When processing format `0` or `1` images: decode pixels, store result in `imageCache[nextCacheIdx++]`, then render to frame buffer
- When processing format `2`: read `dat_len` as cache index, look up `imageCache[dat_len]`, render the cached image to the dest rect
- **Clear the cache at each keyframe** (packet type `0x14`) — cache is only valid between keyframes

## Fault Tolerance

1. Each `TS_RECORD_PKG` is parsed independently in a try-catch
2. On parse failure: if `size` field is plausible (≤ remaining file bytes), skip `size` bytes and continue; otherwise scan forward byte-by-byte for the next valid packet header
3. Corrupted time ranges are recorded in `corruptedRanges[]` and shown as red marks on the progress bar
4. Playback never stops due to data corruption — damaged frames are silently skipped

## Rendering

- **Off-screen canvas** as frame buffer (size = recording width × height)
- Image update packets → zlib decompress (if needed) → RLE decompress (if format=1) → convert RGB565/RGB555 to RGBA → `putImageData()` to frame buffer rect
- Keyframe packets → zlib decompress → convert RGB565/RGB555 to RGBA → full frame write
- **Pixel format conversion**: RGB565 `pixel = (r5 << 11) | (g6 << 5) | b5` → RGBA `[r5<<3, g6<<2, b5<<3, 255]`; RGB555 `pixel = (r5 << 10) | (g5 << 5) | b5` → RGBA `[r5<<3, g5<<3, b5<<3, 255]`
- `requestAnimationFrame` copies frame buffer to display canvas
- Mouse cursor rendered as a red dot overlay on the frame buffer

## Zoom & Pan

- CSS `transform: scale()` + `transform-origin` on the canvas container
- `Cmd + scroll wheel` (macOS) / `Ctrl + scroll wheel` (Windows): zoom in/out (25% steps, range 25%–400%)
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
- `rle.js` — existing Emscripten WASM module for RLE bitmap decompression, copied from server at `server/www/teleport/static/js/audit/rle.js`. Uses `Module.ccall('bitmap_decompress_15', ...)` and `Module.ccall('bitmap_decompress_16', ...)` APIs via `Module._malloc` / `Module._free`
- pako.js for zlib decompression (`pako.inflate()`, not `pako.inflateRaw()` — the data uses zlib wrapper format with 2-byte header + 4-byte checksum)
- fetch API with `credentials: 'include'` for authenticated binary downloads

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Network error | Retry 3×, then show error with retry button |
| Auth expired (`_sid` invalid) | Prompt to re-login, link to login page |
| Unsupported format (magic/ver mismatch) | Clear error message with format details |
| Corrupt frames | Skip + mark on progress bar, continue playback |
| `.tpd` file missing on server | Skip file, show warning, continue with available data |
| HTTP 416 (offset out of range) | Treat as end-of-file, stop reading current `.tpd` |

## How This Solves Each Problem

| Problem | Solution |
|---------|----------|
| 1. No zoom | CSS transform scaling (25%–400%) + fit-to-window + drag-to-pan |
| 2. Crash on corrupt data | Per-packet try-catch, skip corrupt frames, never stop playback |
| 3. Not native on macOS | Browser-based, works on any OS |
| 4. Flaky startup | No TP-Assist dependency, direct URL access |
