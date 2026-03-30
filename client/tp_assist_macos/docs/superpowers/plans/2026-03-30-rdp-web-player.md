# RDP Web Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based RDP recording player that replaces the Qt desktop tp-player, solving zoom, crash-on-corrupt, cross-platform, and startup issues.

**Architecture:** Standalone HTML+CSS+Vanilla JS app. Downloads raw binary `.tpr`/`.tpk`/`.tpd` files from the Teleport server's existing `/audit/get-file` API. Parses binary formats in JS via `DataView` (little-endian). Decompresses images via pako.js (zlib) + rle.js WASM (RLE). Renders to an off-screen `<canvas>` backbuffer, displayed via CSS transform scaling for zoom/pan.

**Tech Stack:** Vanilla JS (ES2020+), HTML5 Canvas, pako.js, Emscripten WASM (rle.js)

**Spec:** `docs/superpowers/specs/2026-03-30-rdp-web-player-design.md`

**Reference source files:**
- Binary format: `client/tp-player/record_format.h`
- Data parsing: `client/tp-player/thr_data.cpp`
- Playback timing: `client/tp-player/thr_play.cpp`
- Qt rendering: `client/tp-player/mainwindow.cpp`
- Existing browser player: `server/www/teleport/static/js/audit/replay-rdp.js`
- WASM RLE usage: `server/www/teleport/static/js/audit/replay-rdp.js` (`$app.decompress()`)

---

## File Structure

```
client/tp-player-web/
├── index.html            # Main page: layout, control bar, canvas container
├── css/
│   └── player.css        # All styles: layout, controls, progress bar, zoom UI
├── js/
│   ├── constants.js      # Binary format constants, magic numbers, packet types
│   ├── downloader.js     # Fetch API wrapper: get-file calls, retry, progress
│   ├── parser.js         # Binary parsing: .tpr header, .tpk index, .tpd packets
│   ├── decoder.js        # Decompression: zlib (pako), RLE (WASM), pixel conversion
│   ├── image-cache.js    # Image cache for ALT format back-references
│   ├── renderer.js       # Canvas backbuffer rendering + cursor overlay
│   ├── player.js         # Playback engine: timing, speed, seek, skip-silence
│   ├── zoom.js           # Zoom/pan: CSS transform, scroll wheel, drag, buttons
│   └── app.js            # Entry point: URL params, init, wire modules, UI events
└── lib/
    ├── pako.min.js       # zlib decompression (from npm pako 2.x)
    └── rle.js            # Emscripten WASM module (copied from server)
```

Each JS file is one ES module (`<script type="module">`). No build step.

---

### Task 1: Project Scaffold and Constants

**Files:**
- Create: `client/tp-player-web/index.html`
- Create: `client/tp-player-web/css/player.css`
- Create: `client/tp-player-web/js/constants.js`

Sets up the HTML skeleton, basic CSS layout, and all binary format constants extracted from `record_format.h`.

- [ ] **Step 1: Create `js/constants.js`**

```javascript
// Binary format constants from record_format.h
// All multi-byte fields are little-endian (pass true to DataView getters)

export const MAGIC_TPPR = 0x52505054;
export const HEADER_VER = 4;
export const TPPR_TYPE_RDP = 0x0101;

// .tpr layout
export const TPR_SIZE = 512;
export const HEADER_INFO_SIZE = 64;   // first 64 bytes
export const HEADER_BASIC_OFFSET = 64;

// .tpd packet types
export const TYPE_RDP_POINTER = 0x12;
export const TYPE_RDP_IMAGE = 0x13;
export const TYPE_RDP_KEYFRAME = 0x14;

// Packet header size
export const PKG_HEADER_SIZE = 12;

// Image formats
export const RDP_IMG_RAW = 0;
export const RDP_IMG_BMP = 1;  // RLE compressed
export const RDP_IMG_ALT = 2;  // cache back-reference

// Image info struct size
export const IMAGE_INFO_SIZE = 24;

// Keyframe info struct size
export const KEYFRAME_INFO_SIZE = 12;
```

- [ ] **Step 2: Create `index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RDP 录屏回放</title>
    <link rel="stylesheet" href="css/player.css">
</head>
<body>
    <div id="top-bar">
        <span id="meta-info">RDP 录屏回放</span>
    </div>

    <div id="canvas-container">
        <div id="canvas-wrapper">
            <canvas id="player-canvas"></canvas>
        </div>
        <div id="loading-overlay">
            <div id="loading-text">加载中...</div>
            <div id="loading-progress"></div>
        </div>
        <div id="error-overlay" style="display:none">
            <div id="error-text"></div>
            <button id="error-retry">重试</button>
        </div>
    </div>

    <div id="control-bar">
        <div id="controls-row-1">
            <button id="btn-play" title="播放/暂停 (空格)">▶</button>
            <div id="progress-container">
                <div id="progress-bar">
                    <div id="progress-played"></div>
                    <div id="progress-handle"></div>
                </div>
            </div>
            <span id="time-display">00:00 / 00:00</span>
            <select id="speed-select">
                <option value="1">1x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
                <option value="8">8x</option>
                <option value="16">16x</option>
            </select>
            <label id="skip-label">
                <input type="checkbox" id="skip-silence" checked> 跳过静默
            </label>
        </div>
        <div id="controls-row-2">
            <button id="btn-fit" title="适应窗口">适应窗口</button>
            <button id="btn-original" title="1:1 原始大小">1:1</button>
            <button id="btn-zoom-in" title="放大">+</button>
            <button id="btn-zoom-out" title="缩小">−</button>
            <span id="zoom-display">100%</span>
        </div>
    </div>

    <script src="lib/pako.min.js"></script>
    <script src="lib/rle.js"></script>
    <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `css/player.css`**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    user-select: none;
}

#top-bar {
    height: 40px;
    background: #16213e;
    display: flex;
    align-items: center;
    padding: 0 16px;
    font-size: 14px;
    border-bottom: 1px solid #0f3460;
    flex-shrink: 0;
}

#canvas-container {
    flex: 1;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a1a;
}

#canvas-wrapper {
    transform-origin: 0 0;
    cursor: grab;
}
#canvas-wrapper.dragging { cursor: grabbing; }

#player-canvas {
    display: block;
    background: #263f6f;
}

#loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.7);
    z-index: 10;
}
#loading-text { font-size: 16px; margin-bottom: 12px; }
#loading-progress { font-size: 13px; color: #8888aa; }

#error-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.8);
    z-index: 20;
}
#error-text { font-size: 14px; color: #ff6b6b; margin-bottom: 16px; text-align: center; padding: 0 20px; }
#error-retry {
    padding: 8px 24px;
    background: #0f3460;
    color: #e0e0e0;
    border: 1px solid #1a5276;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
}
#error-retry:hover { background: #1a5276; }

#control-bar {
    background: #16213e;
    padding: 8px 16px;
    border-top: 1px solid #0f3460;
    flex-shrink: 0;
}

#controls-row-1, #controls-row-2 {
    display: flex;
    align-items: center;
    gap: 12px;
}
#controls-row-2 { margin-top: 6px; }

#controls-row-1 button, #controls-row-2 button {
    padding: 4px 12px;
    background: #0f3460;
    color: #e0e0e0;
    border: 1px solid #1a5276;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
}
#controls-row-1 button:hover, #controls-row-2 button:hover { background: #1a5276; }

#btn-play { font-size: 16px; width: 36px; }

#progress-container {
    flex: 1;
    height: 20px;
    display: flex;
    align-items: center;
    cursor: pointer;
}
#progress-bar {
    width: 100%;
    height: 6px;
    background: #2a2a4a;
    border-radius: 3px;
    position: relative;
}
#progress-played {
    height: 100%;
    background: #4a9eff;
    border-radius: 3px;
    width: 0%;
}
#progress-handle {
    width: 12px;
    height: 12px;
    background: #4a9eff;
    border-radius: 50%;
    position: absolute;
    top: -3px;
    left: 0%;
    transform: translateX(-50%);
}
.corrupt-mark {
    position: absolute;
    height: 100%;
    background: #ff4444;
    opacity: 0.6;
    top: 0;
}

#time-display { font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }

#speed-select {
    padding: 2px 4px;
    background: #0f3460;
    color: #e0e0e0;
    border: 1px solid #1a5276;
    border-radius: 4px;
    font-size: 13px;
}

#skip-label { font-size: 13px; display: flex; align-items: center; gap: 4px; }
#zoom-display { font-size: 13px; min-width: 50px; }
```

- [ ] **Step 4: Verify structure renders in browser**

Open `index.html` in a browser. Should show dark layout with top bar, empty canvas area with "加载中..." overlay, and control bar at bottom.

- [ ] **Step 5: Commit**

```bash
git add client/tp-player-web/
git commit -m "feat(tp-player-web): scaffold project with HTML, CSS, and constants"
```

---

### Task 2: Downloader Module

**Files:**
- Create: `client/tp-player-web/js/downloader.js`

Wraps fetch API calls to `/audit/get-file` with retry logic, progress reporting, and error classification.

- [ ] **Step 1: Create `js/downloader.js`**

```javascript
// Downloader — fetch binary files from Teleport's /audit/get-file API
//
// API contract:
//   GET /audit/get-file?act=size&type=rdp&rid={rid}&f={filename}  → file size as text
//   GET /audit/get-file?act=read&type=rdp&rid={rid}&f={filename}  → binary content
// Authentication: _sid cookie sent automatically (same-origin, credentials: 'include')

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 30000;

export function createDownloader(serverBase, rid) {
    function buildUrl(act, filename, extraParams) {
        const params = new URLSearchParams({
            act,
            type: 'rdp',
            rid: String(rid),
            f: filename,
            ...extraParams,
        });
        return `${serverBase}/audit/get-file?${params}`;
    }

    async function fetchWithRetry(url, options, retries) {
        const retriesLeft = retries ?? MAX_RETRIES;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(url, {
                credentials: 'include',
                signal: controller.signal,
                ...options,
            });
            clearTimeout(timeoutId);
            if (resp.status === 401 || resp.status === 403) {
                throw Object.assign(new Error('认证已过期，请重新登录'), { code: 'AUTH_EXPIRED' });
            }
            if (resp.status === 416) {
                return null; // offset out of range = end of file
            }
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }
            return resp;
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.code === 'AUTH_EXPIRED' || retriesLeft <= 0) throw err;
            if (err.name === 'AbortError') {
                if (retriesLeft <= 0) throw new Error('请求超时');
            }
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            return fetchWithRetry(url, options, retriesLeft - 1);
        }
    }

    async function getFileSize(filename) {
        const url = buildUrl('size', filename);
        const resp = await fetchWithRetry(url);
        const text = await resp.text();
        const size = parseInt(text, 10);
        if (isNaN(size) || size < 0) {
            throw new Error(`无效的文件大小: ${text}`);
        }
        return size;
    }

    async function readFile(filename) {
        const url = buildUrl('read', filename);
        const resp = await fetchWithRetry(url);
        if (!resp) return null;
        const buf = await resp.arrayBuffer();
        return buf;
    }

    async function readFileWithProgress(filename, onProgress) {
        const size = await getFileSize(filename);
        const url = buildUrl('read', filename);
        const resp = await fetchWithRetry(url);
        if (!resp) return null;

        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            if (onProgress) onProgress(received, size);
        }

        const result = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result.buffer;
    }

    return { getFileSize, readFile, readFileWithProgress, buildUrl };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/downloader.js
git commit -m "feat(tp-player-web): add downloader module with retry and progress"
```

---

### Task 3: Binary Parser Module

**Files:**
- Create: `client/tp-player-web/js/parser.js`

Parses `.tpr` header, `.tpk` keyframe index, and `.tpd` packet stream. All DataView reads pass `true` for little-endian. Fault-tolerant packet iteration.

- [ ] **Step 1: Create `js/parser.js`**

```javascript
// Binary format parser for .tpr / .tpk / .tpd files
// Reference: client/tp-player/record_format.h (all structs are #pragma pack(push,1))

import {
    MAGIC_TPPR, HEADER_VER, TPPR_TYPE_RDP,
    TPR_SIZE, HEADER_INFO_SIZE, HEADER_BASIC_OFFSET,
    TYPE_RDP_POINTER, TYPE_RDP_IMAGE, TYPE_RDP_KEYFRAME,
    PKG_HEADER_SIZE, IMAGE_INFO_SIZE, KEYFRAME_INFO_SIZE,
    RDP_IMG_RAW, RDP_IMG_BMP, RDP_IMG_ALT,
} from './constants.js';

const LE = true; // little-endian

function readCString(dv, offset, maxLen) {
    const bytes = [];
    for (let i = 0; i < maxLen; i++) {
        const b = dv.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

export function parseHeader(buffer) {
    if (buffer.byteLength < TPR_SIZE) {
        throw Object.assign(new Error('文件头太短'), { code: 'INVALID_HEADER' });
    }
    const dv = new DataView(buffer);

    const magic = dv.getUint32(0, LE);
    if (magic !== MAGIC_TPPR) {
        throw Object.assign(new Error(`无效的文件格式 (magic: 0x${magic.toString(16)})`), { code: 'INVALID_MAGIC' });
    }

    const ver = dv.getUint16(4, LE);
    if (ver !== HEADER_VER) {
        throw Object.assign(new Error(`不支持的版本: ${ver} (需要 ${HEADER_VER})`), { code: 'UNSUPPORTED_VER' });
    }

    const type = dv.getUint16(6, LE);
    if (type !== TPPR_TYPE_RDP) {
        throw Object.assign(new Error(`不是 RDP 录制 (type: 0x${type.toString(16)})`), { code: 'NOT_RDP' });
    }

    return {
        timeMs: dv.getUint32(8, LE),
        datFileCount: dv.getUint32(12, LE),
        protocolType: dv.getUint16(HEADER_BASIC_OFFSET, LE),
        protocolSubType: dv.getUint16(HEADER_BASIC_OFFSET + 2, LE),
        // timestamp is uint64 — read as two 32-bit halves (good enough for dates before 2106)
        timestamp: dv.getUint32(HEADER_BASIC_OFFSET + 4, LE),
        width: dv.getUint16(HEADER_BASIC_OFFSET + 12, LE),
        height: dv.getUint16(HEADER_BASIC_OFFSET + 14, LE),
        userUsername: readCString(dv, HEADER_BASIC_OFFSET + 16, 64),
        accUsername: readCString(dv, HEADER_BASIC_OFFSET + 80, 64),
        hostIp: readCString(dv, HEADER_BASIC_OFFSET + 144, 40),
        connIp: readCString(dv, HEADER_BASIC_OFFSET + 184, 40),
        connPort: dv.getUint16(HEADER_BASIC_OFFSET + 224, LE),
        clientIp: readCString(dv, HEADER_BASIC_OFFSET + 226, 40),
    };
}

export function parseKeyframes(buffer) {
    const count = Math.floor(buffer.byteLength / KEYFRAME_INFO_SIZE);
    const dv = new DataView(buffer);
    const keyframes = [];
    for (let i = 0; i < count; i++) {
        const off = i * KEYFRAME_INFO_SIZE;
        keyframes.push({
            timeMs: dv.getUint32(off, LE),
            fileIndex: dv.getUint32(off + 4, LE),
            offset: dv.getUint32(off + 8, LE),
        });
    }
    return keyframes;
}

export function parsePointerPayload(dv, offset) {
    return {
        x: dv.getUint16(offset, LE),
        y: dv.getUint16(offset + 2, LE),
        button: dv.getUint8(offset + 4),
        pressed: dv.getUint8(offset + 5),
    };
}

export function parseImagePayload(dv, payloadOffset, payloadSize) {
    const count = dv.getUint16(payloadOffset, LE);
    let cursor = payloadOffset + 2;
    const endOffset = payloadOffset + payloadSize;
    const images = [];

    for (let i = 0; i < count && cursor < endOffset; i++) {
        if (cursor + IMAGE_INFO_SIZE > endOffset) break;

        const info = {
            destLeft: dv.getUint16(cursor, LE),
            destTop: dv.getUint16(cursor + 2, LE),
            destRight: dv.getUint16(cursor + 4, LE),
            destBottom: dv.getUint16(cursor + 6, LE),
            width: dv.getUint16(cursor + 8, LE),
            height: dv.getUint16(cursor + 10, LE),
            bitsPerPixel: dv.getUint16(cursor + 12, LE),
            format: dv.getUint8(cursor + 14),
            // offset 15: _reserved (skip)
            datLen: dv.getUint32(cursor + 16, LE),
            zipLen: dv.getUint32(cursor + 20, LE),
        };
        cursor += IMAGE_INFO_SIZE;

        if (info.format === RDP_IMG_ALT) {
            // ALT: datLen is cache index, no pixel data in packet
            images.push({ ...info, data: null, cacheIndex: info.datLen });
        } else {
            const dataLen = info.zipLen > 0 ? info.zipLen : info.datLen;
            if (cursor + dataLen > endOffset) break;
            const data = new Uint8Array(dv.buffer, dv.byteOffset + cursor, dataLen);
            images.push({ ...info, data: new Uint8Array(data) }); // copy to detach from source
            cursor += dataLen;
        }
    }
    return images;
}

export function parseKeyframePayload(dv, payloadOffset, payloadSize) {
    const info = {
        timeMs: dv.getUint32(payloadOffset, LE),
        fileIndex: dv.getUint32(payloadOffset + 4, LE),
        offset: dv.getUint32(payloadOffset + 8, LE),
    };
    const dataOffset = payloadOffset + KEYFRAME_INFO_SIZE;
    const dataLen = payloadSize - KEYFRAME_INFO_SIZE;
    const data = new Uint8Array(dv.buffer, dv.byteOffset + dataOffset, dataLen);
    return { info, data: new Uint8Array(data) };
}

// Fault-tolerant packet iterator over a .tpd ArrayBuffer.
// Yields { type, size, timeMs, payloadOffset } for each packet.
// On corrupt data: skips by size if plausible, else scans forward.
// Records corrupt ranges in the provided array.
export function* iteratePackets(buffer, corruptedRanges) {
    const dv = new DataView(buffer);
    const totalLen = buffer.byteLength;
    let pos = 0;

    while (pos + PKG_HEADER_SIZE <= totalLen) {
        try {
            const type = dv.getUint8(pos);
            const size = dv.getUint32(pos + 1, LE);
            const timeMs = dv.getUint32(pos + 5, LE);
            const payloadOffset = pos + PKG_HEADER_SIZE;

            // Validate packet
            const validType = (type === TYPE_RDP_POINTER || type === TYPE_RDP_IMAGE || type === TYPE_RDP_KEYFRAME);
            const validSize = (payloadOffset + size <= totalLen) && (size < 50 * 1024 * 1024); // sanity: <50MB

            if (!validType || !validSize) {
                throw new Error('invalid packet');
            }

            yield { type, size, timeMs, payloadOffset, buffer };
            pos = payloadOffset + size;
        } catch {
            // Record corruption
            const corruptStart = pos;
            // Try to skip by size field if it looks plausible
            const sizeField = pos + 1 + 4 <= totalLen ? dv.getUint32(pos + 1, LE) : 0;
            if (sizeField > 0 && sizeField < totalLen && pos + PKG_HEADER_SIZE + sizeField <= totalLen) {
                pos = pos + PKG_HEADER_SIZE + sizeField;
            } else {
                // Scan forward byte by byte for next valid packet header
                pos++;
                while (pos + PKG_HEADER_SIZE <= totalLen) {
                    const t = dv.getUint8(pos);
                    if (t === TYPE_RDP_POINTER || t === TYPE_RDP_IMAGE || t === TYPE_RDP_KEYFRAME) {
                        const s = dv.getUint32(pos + 1, LE);
                        if (s > 0 && s < 50 * 1024 * 1024 && pos + PKG_HEADER_SIZE + s <= totalLen) {
                            break; // found a plausible next packet
                        }
                    }
                    pos++;
                }
            }
            if (corruptedRanges) {
                corruptedRanges.push({ startOffset: corruptStart, endOffset: pos });
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/parser.js
git commit -m "feat(tp-player-web): add binary parser with fault-tolerant packet iteration"
```

---

### Task 4: Decoder Module

**Files:**
- Create: `client/tp-player-web/js/decoder.js`
- Copy: `server/www/teleport/static/js/audit/rle.js` → `client/tp-player-web/lib/rle.js`
- Download: pako.min.js → `client/tp-player-web/lib/pako.min.js`

Handles two-layer decompression (zlib via pako, RLE via WASM) and RGB565/RGB555→RGBA pixel conversion.

- [ ] **Step 1: Copy `rle.js` from server static assets**

```bash
cp server/www/teleport/static/js/audit/rle.js client/tp-player-web/lib/rle.js
```

- [ ] **Step 2: Download pako.min.js**

```bash
curl -o client/tp-player-web/lib/pako.min.js https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
```

- [ ] **Step 3: Create `js/decoder.js`**

```javascript
// Decoder — zlib decompression (pako) + RLE decompression (WASM) + pixel format conversion
//
// Two-layer decompression for RDP_IMG_BMP (format=1):
//   1. zlib decompress (if zip_len > 0) via pako.inflate()
//   2. RLE bitmap decompress via rle.js WASM Module.ccall()
//
// Pixel conversion for keyframes and raw images:
//   RGB565 → RGBA, RGB555 → RGBA
//
// Reference: client/tp-player/thr_data.cpp _rdpimg2QImage() and _raw2QImage()

import { RDP_IMG_RAW, RDP_IMG_BMP } from './constants.js';

// Wait for Emscripten WASM module to be ready
let wasmReady = false;
let wasmReadyPromise = null;

export function initDecoder() {
    if (wasmReadyPromise) return wasmReadyPromise;
    wasmReadyPromise = new Promise((resolve) => {
        if (typeof Module !== 'undefined' && Module.calledRun) {
            wasmReady = true;
            resolve();
            return;
        }
        // Module.onRuntimeInitialized is called by Emscripten when WASM is loaded
        const origOnInit = (typeof Module !== 'undefined' && Module.onRuntimeInitialized) || null;
        if (typeof Module === 'undefined') window.Module = {};
        Module.onRuntimeInitialized = function () {
            wasmReady = true;
            if (origOnInit) origOnInit();
            resolve();
        };
        // If Module was already initialized before we set the callback
        if (typeof Module !== 'undefined' && Module.calledRun) {
            wasmReady = true;
            resolve();
        }
    });
    return wasmReadyPromise;
}

// zlib decompress using pako
export function zlibDecompress(compressedData) {
    // pako is loaded as a global via <script src="lib/pako.min.js">
    return pako.inflate(compressedData);
}

// RLE decompress a single bitmap tile via WASM
// Returns Uint8ClampedArray of RGBA pixels (width * height * 4 bytes)
export function rleDecompress(inputData, width, height, bitsPerPixel) {
    if (!wasmReady) {
        throw new Error('WASM RLE module not ready');
    }

    const funcName = bitsPerPixel === 15 ? 'bitmap_decompress_15' : 'bitmap_decompress_16';
    const outputSize = width * height * 4; // RGBA
    const inputSize = inputData.byteLength;

    // Allocate WASM heap buffers
    const outPtr = Module._malloc(outputSize);
    const inPtr = Module._malloc(inputSize);

    // Copy input data to WASM heap
    Module.HEAPU8.set(inputData, inPtr);

    // Call WASM function
    // Signature: (outPtr, out_w, out_h, in_w, in_h, inPtr, inLen) -> int
    Module.ccall(
        funcName, 'number',
        ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
        [outPtr, width, height, width, height, inPtr, inputSize]
    );

    // Copy output from WASM heap
    const output = new Uint8ClampedArray(outputSize);
    output.set(new Uint8Array(Module.HEAPU8.buffer, outPtr, outputSize));

    // Free WASM heap
    Module._free(outPtr);
    Module._free(inPtr);

    return output;
}

// Convert RGB565 raw pixel buffer to RGBA Uint8ClampedArray
// Input: Uint8Array of width*height*2 bytes (little-endian RGB565)
export function rgb565ToRgba(input, width, height) {
    const pixelCount = width * height;
    const output = new Uint8ClampedArray(pixelCount * 4);
    const srcView = new DataView(input.buffer, input.byteOffset, input.byteLength);

    for (let i = 0; i < pixelCount; i++) {
        const pixel = srcView.getUint16(i * 2, true);
        const r5 = (pixel >> 11) & 0x1F;
        const g6 = (pixel >> 5) & 0x3F;
        const b5 = pixel & 0x1F;
        const j = i * 4;
        output[j] = (r5 * 255 / 31) | 0;
        output[j + 1] = (g6 * 255 / 63) | 0;
        output[j + 2] = (b5 * 255 / 31) | 0;
        output[j + 3] = 255;
    }
    return output;
}

// Convert RGB555 raw pixel buffer to RGBA Uint8ClampedArray
export function rgb555ToRgba(input, width, height) {
    const pixelCount = width * height;
    const output = new Uint8ClampedArray(pixelCount * 4);
    const srcView = new DataView(input.buffer, input.byteOffset, input.byteLength);

    for (let i = 0; i < pixelCount; i++) {
        const pixel = srcView.getUint16(i * 2, true);
        const r5 = (pixel >> 10) & 0x1F;
        const g5 = (pixel >> 5) & 0x1F;
        const b5 = pixel & 0x1F;
        const j = i * 4;
        output[j] = (r5 * 255 / 31) | 0;
        output[j + 1] = (g5 * 255 / 31) | 0;
        output[j + 2] = (b5 * 255 / 31) | 0;
        output[j + 3] = 255;
    }
    return output;
}

// Decode a single image tile from an RDP_IMAGE packet
// Returns { rgba: Uint8ClampedArray, width, height } or null on failure
export function decodeImageTile(imageInfo) {
    const { data, width, height, bitsPerPixel, format, datLen, zipLen } = imageInfo;

    if (format === RDP_IMG_RAW) {
        // Raw pixels — may need vertical flip (bottom-up row order)
        let pixelData = data;
        if (zipLen > 0) {
            pixelData = zlibDecompress(data);
        }
        const rgba = bitsPerPixel === 15
            ? rgb555ToRgba(pixelData, width, height)
            : rgb565ToRgba(pixelData, width, height);
        // Flip vertically (raw bitmaps are bottom-up)
        flipVertical(rgba, width, height);
        return { rgba, width, height };
    }

    if (format === RDP_IMG_BMP) {
        // Two-layer: zlib (optional) then RLE
        let rleData = data;
        if (zipLen > 0) {
            rleData = zlibDecompress(data);
        }
        const rgba = rleDecompress(new Uint8Array(rleData), width, height, bitsPerPixel);
        return { rgba, width, height };
    }

    return null; // ALT handled by caller via image cache
}

// Decode a keyframe's full-screen pixel data
// Input: raw or zlib-compressed pixel data, screen width/height
// Note: keyframes are always RGB565 (confirmed in thr_data.cpp _raw2QImage)
export function decodeKeyframe(data, width, height) {
    const expectedSize = width * height * 2;
    let pixelData = data;
    if (data.byteLength !== expectedSize) {
        pixelData = zlibDecompress(data);
    }
    return rgb565ToRgba(new Uint8Array(pixelData), width, height);
}

// Flip RGBA pixel array vertically in-place
function flipVertical(rgba, width, height) {
    const rowBytes = width * 4;
    const temp = new Uint8ClampedArray(rowBytes);
    for (let y = 0; y < Math.floor(height / 2); y++) {
        const topOff = y * rowBytes;
        const botOff = (height - 1 - y) * rowBytes;
        temp.set(rgba.subarray(topOff, topOff + rowBytes));
        rgba.copyWithin(topOff, botOff, botOff + rowBytes);
        rgba.set(temp, botOff);
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add client/tp-player-web/js/decoder.js client/tp-player-web/lib/
git commit -m "feat(tp-player-web): add decoder with zlib, RLE, and pixel conversion"
```

---

### Task 5: Image Cache Module

**Files:**
- Create: `client/tp-player-web/js/image-cache.js`

Simple cache for ALT-format (format=2) back-references. Cleared on every keyframe.

- [ ] **Step 1: Create `js/image-cache.js`**

```javascript
// Image cache for RDP ALT-format (format=2) back-references.
// Reference: client/tp-player/thr_data.cpp m_cache_imgs
//
// - Format 0/1 images: after decoding, store in cache via push()
// - Format 2 images: look up by index via get(cacheIndex)
// - Clear on every keyframe packet

export function createImageCache() {
    let entries = [];

    return {
        push(entry) {
            // entry: { rgba: Uint8ClampedArray, width, height, destLeft, destTop }
            entries.push(entry);
        },

        get(index) {
            if (index >= 0 && index < entries.length) {
                return entries[index];
            }
            return null;
        },

        clear() {
            entries = [];
        },

        get size() {
            return entries.length;
        },
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/image-cache.js
git commit -m "feat(tp-player-web): add image cache for ALT back-references"
```

---

### Task 6: Renderer Module

**Files:**
- Create: `client/tp-player-web/js/renderer.js`

Manages the off-screen canvas backbuffer, renders decoded image tiles and keyframes, draws cursor overlay, and copies to display canvas.

- [ ] **Step 1: Create `js/renderer.js`**

```javascript
// Renderer — off-screen canvas backbuffer + cursor overlay
// Reference: client/tp-player/mainwindow.cpp _do_update_data()
//
// - Maintains an off-screen canvas (backbuffer) at recording resolution
// - Renders decoded image tiles via putImageData
// - Draws cursor position as a red dot
// - Copies backbuffer to visible canvas via drawImage

export function createRenderer(displayCanvas) {
    const displayCtx = displayCanvas.getContext('2d');

    // Off-screen backbuffer — created when header is received
    let backbuffer = null;
    let backCtx = null;
    let screenWidth = 0;
    let screenHeight = 0;

    // Cursor state
    let cursorX = 0;
    let cursorY = 0;
    const CURSOR_RADIUS = 5;

    function init(width, height) {
        screenWidth = width;
        screenHeight = height;

        // Set display canvas size to match recording
        displayCanvas.width = width;
        displayCanvas.height = height;

        // Create off-screen backbuffer
        backbuffer = new OffscreenCanvas(width, height);
        backCtx = backbuffer.getContext('2d');

        // Fill with dark blue background (same as Qt player: #263f6f)
        backCtx.fillStyle = '#263f6f';
        backCtx.fillRect(0, 0, width, height);

        flush();
    }

    function renderImageTile(rgba, destLeft, destTop, width, height) {
        if (!backCtx) return;
        const imageData = new ImageData(rgba, width, height);
        backCtx.putImageData(imageData, destLeft, destTop);
    }

    function renderKeyframe(rgba, width, height) {
        if (!backCtx) return;
        const imageData = new ImageData(rgba, width, height);
        backCtx.putImageData(imageData, 0, 0);
    }

    function updateCursor(x, y) {
        cursorX = x;
        cursorY = y;
    }

    // Copy backbuffer to display canvas + draw cursor
    function flush() {
        if (!backbuffer) return;
        displayCtx.drawImage(backbuffer, 0, 0);

        // Draw cursor as red dot
        if (cursorX > 0 || cursorY > 0) {
            displayCtx.beginPath();
            displayCtx.arc(cursorX, cursorY, CURSOR_RADIUS, 0, 2 * Math.PI);
            displayCtx.fillStyle = 'rgba(255, 50, 50, 0.8)';
            displayCtx.fill();
            displayCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            displayCtx.lineWidth = 1;
            displayCtx.stroke();
        }
    }

    function clear() {
        if (backCtx) {
            backCtx.fillStyle = '#263f6f';
            backCtx.fillRect(0, 0, screenWidth, screenHeight);
        }
        flush();
    }

    return {
        init,
        renderImageTile,
        renderKeyframe,
        updateCursor,
        flush,
        clear,
        get width() { return screenWidth; },
        get height() { return screenHeight; },
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/renderer.js
git commit -m "feat(tp-player-web): add renderer with backbuffer and cursor overlay"
```

---

### Task 7: Playback Engine

**Files:**
- Create: `client/tp-player-web/js/player.js`

Core playback loop: timing, speed control, skip-silence, seek via keyframes. Processes pre-parsed packets and drives the renderer.

- [ ] **Step 1: Create `js/player.js`**

```javascript
// Playback engine — timing, speed, seek, skip-silence
// Reference: client/tp-player/thr_play.cpp (timing model)
//            server/www/teleport/static/js/audit/replay-rdp.js (setTimeout loop)
//
// Timing model (from thr_play.cpp):
//   - Packets have absolute timeMs timestamps
//   - Each tick: advance virtual clock by (tick_interval * speed)
//   - Process all packets with timeMs <= virtual clock
//   - Skip-silence: compress gaps > 1000ms to 1000ms

import {
    TYPE_RDP_POINTER, TYPE_RDP_IMAGE, TYPE_RDP_KEYFRAME,
    RDP_IMG_ALT,
} from './constants.js';
import {
    parsePointerPayload, parseImagePayload, parseKeyframePayload,
} from './parser.js';
import { decodeImageTile, decodeKeyframe } from './decoder.js';

const TICK_MS = 33; // ~30fps
const SILENCE_THRESHOLD_MS = 1000;

export function createPlayer(renderer, imageCache, callbacks) {
    // callbacks: { onProgress(currentMs, totalMs), onEnd(), onError(err) }

    let packets = [];      // pre-parsed packet list: [{ type, timeMs, payloadOffset, size, buffer }, ...]
    let keyframes = [];    // from .tpk
    let totalMs = 0;
    let currentMs = 0;
    let packetIndex = 0;
    let speed = 1;
    let skipSilence = true;
    let playing = false;
    let timerId = null;

    function load(parsedPackets, parsedKeyframes, durationMs) {
        packets = parsedPackets;
        keyframes = parsedKeyframes;
        totalMs = durationMs;
        currentMs = 0;
        packetIndex = 0;
    }

    // Hot-merge updated packet list without resetting playback position.
    // Used when background .tpd files finish downloading.
    function updatePackets(parsedPackets, parsedKeyframes, durationMs) {
        const prevMs = currentMs;
        packets = parsedPackets;
        keyframes = parsedKeyframes;
        totalMs = durationMs;
        // Restore packetIndex to the correct position for the current time
        packetIndex = findPacketIndex(prevMs);
        // Skip past any packets we've already played
        while (packetIndex < packets.length && packets[packetIndex].timeMs < prevMs) {
            packetIndex++;
        }
    }

    function play() {
        if (playing) return;
        playing = true;
        scheduleTick();
    }

    function pause() {
        playing = false;
        if (timerId !== null) {
            cancelAnimationFrame(timerId);
            timerId = null;
        }
    }

    function togglePlayPause() {
        if (playing) { pause(); } else { play(); }
        return playing;
    }

    function setSpeed(s) {
        speed = s;
    }

    function setSkipSilence(skip) {
        skipSilence = skip;
    }

    function seek(targetMs) {
        pause();

        // Find nearest keyframe before targetMs
        let kfIndex = -1;
        for (let i = keyframes.length - 1; i >= 0; i--) {
            if (keyframes[i].timeMs <= targetMs) {
                kfIndex = i;
                break;
            }
        }

        // Reset image cache
        imageCache.clear();

        if (kfIndex >= 0) {
            const kfTimeMs = keyframes[kfIndex].timeMs;
            packetIndex = findPacketIndex(kfTimeMs);
        } else {
            packetIndex = 0;
        }

        // Fast-forward from keyframe to target, rendering silently
        currentMs = packets.length > 0 && packetIndex < packets.length
            ? packets[packetIndex].timeMs
            : 0;

        while (packetIndex < packets.length && packets[packetIndex].timeMs <= targetMs) {
            processPacket(packetIndex);
            packetIndex++;
        }
        currentMs = targetMs;

        renderer.flush();
        if (callbacks.onProgress) callbacks.onProgress(currentMs, totalMs);
        // Note: caller is responsible for calling play() after seek if desired
    }

    function findPacketIndex(timeMs) {
        // Binary search for first packet with timeMs >= target
        let lo = 0, hi = packets.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (packets[mid].timeMs < timeMs) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function scheduleTick() {
        if (!playing) return;
        timerId = requestAnimationFrame(tick);
    }

    function tick() {
        if (!playing) return;

        const advanceMs = TICK_MS * speed;
        let nextMs = currentMs + advanceMs;

        // Skip silence: if next packet is far ahead, jump forward
        if (skipSilence && packetIndex < packets.length) {
            const nextPacketMs = packets[packetIndex].timeMs;
            if (nextPacketMs - currentMs > SILENCE_THRESHOLD_MS) {
                nextMs = nextPacketMs;
            }
        }

        // Process all packets up to nextMs
        let rendered = false;
        while (packetIndex < packets.length && packets[packetIndex].timeMs <= nextMs) {
            processPacket(packetIndex);
            packetIndex++;
            rendered = true;
        }

        currentMs = Math.min(nextMs, totalMs);

        if (rendered) {
            renderer.flush();
        }

        if (callbacks.onProgress) callbacks.onProgress(currentMs, totalMs);

        // Check if playback finished
        if (packetIndex >= packets.length && currentMs >= totalMs) {
            playing = false;
            if (callbacks.onEnd) callbacks.onEnd();
            return;
        }

        scheduleTick();
    }

    function processPacket(index) {
        const pkt = packets[index];
        const dv = new DataView(pkt.buffer);

        try {
            switch (pkt.type) {
                case TYPE_RDP_POINTER: {
                    const ptr = parsePointerPayload(dv, pkt.payloadOffset);
                    renderer.updateCursor(ptr.x, ptr.y);
                    break;
                }
                case TYPE_RDP_IMAGE: {
                    const images = parseImagePayload(dv, pkt.payloadOffset, pkt.size);
                    for (const img of images) {
                        if (img.format === RDP_IMG_ALT) {
                            const cached = imageCache.get(img.cacheIndex);
                            if (cached) {
                                renderer.renderImageTile(cached.rgba, img.destLeft, img.destTop, cached.width, cached.height);
                            }
                        } else {
                            const decoded = decodeImageTile(img);
                            if (decoded) {
                                const destW = img.destRight - img.destLeft + 1;
                                const destH = img.destBottom - img.destTop + 1;
                                imageCache.push({
                                    rgba: decoded.rgba,
                                    width: destW,
                                    height: destH,
                                    destLeft: img.destLeft,
                                    destTop: img.destTop,
                                });
                                renderer.renderImageTile(decoded.rgba, img.destLeft, img.destTop, destW, destH);
                            }
                        }
                    }
                    break;
                }
                case TYPE_RDP_KEYFRAME: {
                    imageCache.clear();
                    const kf = parseKeyframePayload(dv, pkt.payloadOffset, pkt.size);
                    const rgba = decodeKeyframe(kf.data, renderer.width, renderer.height);
                    renderer.renderKeyframe(rgba, renderer.width, renderer.height);
                    break;
                }
            }
        } catch (err) {
            // Fault tolerance: skip corrupt packet, continue playback
            console.warn(`Packet #${index} (type=0x${pkt.type.toString(16)}, time=${pkt.timeMs}ms) decode error:`, err);
        }
    }

    return {
        load,
        updatePackets,
        play,
        pause,
        togglePlayPause,
        seek,
        setSpeed,
        setSkipSilence,
        get playing() { return playing; },
        get currentMs() { return currentMs; },
        get totalMs() { return totalMs; },
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/player.js
git commit -m "feat(tp-player-web): add playback engine with timing, seek, and fault tolerance"
```

---

### Task 8: Zoom and Pan Module

**Files:**
- Create: `client/tp-player-web/js/zoom.js`

CSS transform-based zoom/pan on the canvas wrapper. Scroll wheel zoom, button controls, drag to pan.

- [ ] **Step 1: Create `js/zoom.js`**

```javascript
// Zoom & Pan — CSS transform-based scaling on #canvas-wrapper
// Reference: spec Zoom & Pan section
//
// - Cmd+scroll (macOS) / Ctrl+scroll (Windows): zoom 25% steps, range 25%-400%
// - Buttons: Fit Window, 1:1, +, -
// - Click-drag to pan when zoomed in

export function createZoomController(canvasWrapper, canvasContainer, displayEl) {
    let scale = 1.0;
    let panX = 0;
    let panY = 0;
    let canvasWidth = 0;
    let canvasHeight = 0;

    const MIN_SCALE = 0.25;
    const MAX_SCALE = 4.0;
    const STEP = 0.25;

    // Drag state
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let panStartX = 0;
    let panStartY = 0;

    function init(width, height) {
        canvasWidth = width;
        canvasHeight = height;
        fitToWindow();
    }

    function setScale(newScale) {
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        applyTransform();
        updateDisplay();
    }

    function fitToWindow() {
        const containerRect = canvasContainer.getBoundingClientRect();
        const scaleX = containerRect.width / canvasWidth;
        const scaleY = containerRect.height / canvasHeight;
        scale = Math.min(scaleX, scaleY, 1.0); // don't upscale beyond 1:1
        panX = 0;
        panY = 0;
        applyTransform();
        updateDisplay();
    }

    function originalSize() {
        scale = 1.0;
        panX = 0;
        panY = 0;
        applyTransform();
        updateDisplay();
    }

    function zoomIn() { setScale(scale + STEP); }
    function zoomOut() { setScale(scale - STEP); }

    function applyTransform() {
        // Center the canvas in the container
        const containerRect = canvasContainer.getBoundingClientRect();
        const scaledW = canvasWidth * scale;
        const scaledH = canvasHeight * scale;
        const offsetX = Math.max(0, (containerRect.width - scaledW) / 2);
        const offsetY = Math.max(0, (containerRect.height - scaledH) / 2);

        canvasWrapper.style.transform = `translate(${offsetX + panX}px, ${offsetY + panY}px) scale(${scale})`;
    }

    function updateDisplay() {
        if (displayEl) displayEl.textContent = `${Math.round(scale * 100)}%`;
    }

    // Scroll wheel zoom
    function handleWheel(e) {
        if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -STEP : STEP;
            setScale(scale + delta);
        }
    }

    // Drag to pan
    function handleMouseDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = panX;
        panStartY = panY;
        canvasWrapper.classList.add('dragging');
    }

    function handleMouseMove(e) {
        if (!dragging) return;
        panX = panStartX + (e.clientX - dragStartX);
        panY = panStartY + (e.clientY - dragStartY);
        applyTransform();
    }

    function handleMouseUp() {
        if (!dragging) return;
        dragging = false;
        canvasWrapper.classList.remove('dragging');
    }

    // Attach event listeners
    canvasContainer.addEventListener('wheel', handleWheel, { passive: false });
    canvasWrapper.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return { init, fitToWindow, originalSize, zoomIn, zoomOut, get scale() { return scale; } };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/zoom.js
git commit -m "feat(tp-player-web): add zoom/pan with scroll wheel and drag"
```

---

### Task 9: App Entry Point — Wire Everything Together

**Files:**
- Create: `client/tp-player-web/js/app.js`

Reads URL params, initializes all modules, downloads recording files, parses packets, starts playback, and wires UI controls.

- [ ] **Step 1: Create `js/app.js`**

```javascript
// App entry point — wires all modules together
//
// URL params: ?rid=123 (required)
//   Server base URL defaults to same origin; override with ?server=https://...
//   Session ID from cookie; override with ?sid=xxx

import { createDownloader } from './downloader.js';
import { parseHeader, parseKeyframes, iteratePackets } from './parser.js';
import { initDecoder } from './decoder.js';
import { createImageCache } from './image-cache.js';
import { createRenderer } from './renderer.js';
import { createPlayer } from './player.js';
import { createZoomController } from './zoom.js';

// --- URL params ---
const params = new URLSearchParams(window.location.search);
const rid = params.get('rid');
const serverBase = params.get('server') || window.location.origin;

if (!rid) {
    showError('缺少参数: rid (录制ID)\n用法: ?rid=123');
    throw new Error('Missing rid parameter');
}

// --- DOM refs ---
const canvas = document.getElementById('player-canvas');
const canvasWrapper = document.getElementById('canvas-wrapper');
const canvasContainer = document.getElementById('canvas-container');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const loadingProgress = document.getElementById('loading-progress');
const errorOverlay = document.getElementById('error-overlay');
const errorText = document.getElementById('error-text');
const metaInfo = document.getElementById('meta-info');
const btnPlay = document.getElementById('btn-play');
const speedSelect = document.getElementById('speed-select');
const skipSilence = document.getElementById('skip-silence');
const progressContainer = document.getElementById('progress-container');
const progressPlayed = document.getElementById('progress-played');
const progressHandle = document.getElementById('progress-handle');
const progressBar = document.getElementById('progress-bar');
const timeDisplay = document.getElementById('time-display');
const btnFit = document.getElementById('btn-fit');
const btnOriginal = document.getElementById('btn-original');
const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const zoomDisplay = document.getElementById('zoom-display');
const errorRetry = document.getElementById('error-retry');

// --- Modules ---
const downloader = createDownloader(serverBase, rid);
const imageCache = createImageCache();
const renderer = createRenderer(canvas);
const zoom = createZoomController(canvasWrapper, canvasContainer, zoomDisplay);

const player = createPlayer(renderer, imageCache, {
    onProgress(currentMs, totalMs) {
        updateProgressBar(currentMs, totalMs);
    },
    onEnd() {
        btnPlay.textContent = '▶';
    },
    onError(err) {
        console.error('Playback error:', err);
    },
});

// --- Format time ---
function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateProgressBar(currentMs, totalMs) {
    const pct = totalMs > 0 ? (currentMs / totalMs) * 100 : 0;
    progressPlayed.style.width = `${pct}%`;
    progressHandle.style.left = `${pct}%`;
    timeDisplay.textContent = `${formatTime(currentMs)} / ${formatTime(totalMs)}`;
}

function showError(msg) {
    loadingOverlay.style.display = 'none';
    errorOverlay.style.display = 'flex';
    errorText.textContent = msg;
}

// Render corrupt time ranges as red marks on progress bar
function renderCorruptMarks(corruptedRanges, packets, totalMs) {
    // Remove existing marks
    progressBar.querySelectorAll('.corrupt-mark').forEach(el => el.remove());
    if (corruptedRanges.length === 0 || totalMs <= 0) return;

    // Approximate time ranges from nearby packet timestamps
    for (const range of corruptedRanges) {
        // Find nearest packets before/after the corrupt byte offsets to estimate time
        let startMs = 0, endMs = totalMs;
        for (const pkt of packets) {
            if (pkt.payloadOffset <= range.startOffset) startMs = pkt.timeMs;
            if (pkt.payloadOffset >= range.endOffset) { endMs = pkt.timeMs; break; }
        }
        const leftPct = (startMs / totalMs) * 100;
        const widthPct = Math.max(0.5, ((endMs - startMs) / totalMs) * 100); // min 0.5% visible
        const mark = document.createElement('div');
        mark.className = 'corrupt-mark';
        mark.style.left = `${leftPct}%`;
        mark.style.width = `${widthPct}%`;
        mark.title = `损坏区域: ${formatTime(startMs)} - ${formatTime(endMs)}`;
        progressBar.appendChild(mark);
    }
}

function showLoading(text, progress) {
    loadingOverlay.style.display = 'flex';
    errorOverlay.style.display = 'none';
    loadingText.textContent = text;
    loadingProgress.textContent = progress || '';
}

function hideOverlays() {
    loadingOverlay.style.display = 'none';
    errorOverlay.style.display = 'none';
}

// --- Main init ---
async function init() {
    try {
        showLoading('正在加载 WASM 模块...');
        await initDecoder();

        showLoading('正在下载录制头...');
        const tprBuf = await downloader.readFile('tp-rdp.tpr');
        if (!tprBuf) throw new Error('无法下载 tp-rdp.tpr');

        const header = parseHeader(tprBuf);
        metaInfo.textContent = `RDP 录屏回放 — ${header.accUsername}@${header.hostIp} (${header.userUsername})`;
        document.title = `RDP 回放 — ${header.accUsername}@${header.hostIp}`;

        // Init renderer and zoom
        renderer.init(header.width, header.height);
        zoom.init(header.width, header.height);

        // Download keyframes
        showLoading('正在下载关键帧索引...');
        const tpkBuf = await downloader.readFile('tp-rdp.tpk');
        const keyframes = tpkBuf ? parseKeyframes(tpkBuf) : [];

        // Download and parse first .tpd file, start playback immediately
        const allPackets = [];
        const corruptedRanges = [];
        const tpdBuffers = new Array(header.datFileCount).fill(null);

        if (header.datFileCount > 0) {
            showLoading('正在下载数据文件 1/' + header.datFileCount + '...', '');
            const firstBuf = await downloader.readFileWithProgress('tp-rdp-1.tpd', (received, total) => {
                const pct = total > 0 ? Math.round(received / total * 100) : 0;
                loadingProgress.textContent = `${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`;
            });
            if (firstBuf) {
                tpdBuffers[0] = firstBuf;
                for (const pkt of iteratePackets(firstBuf, corruptedRanges)) {
                    allPackets.push(pkt);
                }
            }
        }

        // Sort and load player with first file's packets
        allPackets.sort((a, b) => a.timeMs - b.timeMs);
        player.load(allPackets, keyframes, header.timeMs);
        renderCorruptMarks(corruptedRanges, allPackets, header.timeMs);
        updateProgressBar(0, header.timeMs);
        hideOverlays();
        player.play();
        btnPlay.textContent = '⏸';

        // Background-download remaining .tpd files
        for (let i = 2; i <= header.datFileCount; i++) {
            const filename = `tp-rdp-${i}.tpd`;
            const tpdBuf = await downloader.readFileWithProgress(filename, () => {});
            if (!tpdBuf) {
                console.warn(`Skipping missing file: ${filename}`);
                continue;
            }
            tpdBuffers[i - 1] = tpdBuf;
            for (const pkt of iteratePackets(tpdBuf, corruptedRanges)) {
                allPackets.push(pkt);
            }
            // Create a sorted copy (immutable) and hot-merge into player
            const sorted = [...allPackets].sort((a, b) => a.timeMs - b.timeMs);
            allPackets.length = 0;
            allPackets.push(...sorted);
            player.updatePackets(allPackets, keyframes, header.timeMs);
            renderCorruptMarks(corruptedRanges, allPackets, header.timeMs);
        }

    } catch (err) {
        console.error('Init error:', err);
        if (err.code === 'AUTH_EXPIRED') {
            showError('认证已过期，请重新登录后再试');
        } else {
            showError(`加载失败: ${err.message}`);
        }
    }
}

// --- UI event handlers ---

btnPlay.addEventListener('click', () => {
    const isPlaying = player.togglePlayPause();
    btnPlay.textContent = isPlaying ? '⏸' : '▶';
});

speedSelect.addEventListener('change', () => {
    player.setSpeed(parseInt(speedSelect.value, 10));
});

skipSilence.addEventListener('change', () => {
    player.setSkipSilence(skipSilence.checked);
});

// Progress bar seek
let seeking = false;
let wasPlayingBeforeSeek = false;
progressContainer.addEventListener('mousedown', (e) => {
    seeking = true;
    wasPlayingBeforeSeek = player.playing;
    player.pause();
    seekToPosition(e);
});
window.addEventListener('mousemove', (e) => {
    if (seeking) seekToPosition(e);
});
window.addEventListener('mouseup', () => {
    if (seeking) {
        seeking = false;
        if (wasPlayingBeforeSeek) {
            player.play();
            btnPlay.textContent = '⏸';
        }
    }
});

function seekToPosition(e) {
    const rect = progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetMs = pct * player.totalMs;
    player.seek(targetMs);
}

// Zoom buttons
btnFit.addEventListener('click', () => zoom.fitToWindow());
btnOriginal.addEventListener('click', () => zoom.originalSize());
btnZoomIn.addEventListener('click', () => zoom.zoomIn());
btnZoomOut.addEventListener('click', () => zoom.zoomOut());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            btnPlay.click();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            { const wasP = player.playing;
              player.seek(Math.max(0, player.currentMs - 10000));
              if (wasP) player.play(); }
            break;
        case 'ArrowRight':
            e.preventDefault();
            { const wasP = player.playing;
              player.seek(Math.min(player.totalMs, player.currentMs + 10000));
              if (wasP) player.play(); }
            break;
        case 'Equal': // + key → speed up
        case 'NumpadAdd': {
            e.preventDefault();
            const idx = speedSelect.selectedIndex;
            if (idx < speedSelect.options.length - 1) {
                speedSelect.selectedIndex = idx + 1;
                speedSelect.dispatchEvent(new Event('change'));
            }
            break;
        }
        case 'Minus': // - key → speed down
        case 'NumpadSubtract': {
            e.preventDefault();
            const idx = speedSelect.selectedIndex;
            if (idx > 0) {
                speedSelect.selectedIndex = idx - 1;
                speedSelect.dispatchEvent(new Event('change'));
            }
            break;
        }
    }
});

// Retry button
errorRetry.addEventListener('click', () => init());

// Window resize → re-fit zoom if in fit mode
window.addEventListener('resize', () => zoom.fitToWindow());

// Start
init();
```

- [ ] **Step 2: Commit**

```bash
git add client/tp-player-web/js/app.js
git commit -m "feat(tp-player-web): add app entry point wiring all modules"
```

---

### Task 10: Integration Testing with Real Data

**Files:**
- No new files; test against a running Teleport server

This task verifies the player works end-to-end against real recording data.

- [ ] **Step 1: Deploy to server static directory**

```bash
# Copy tp-player-web to Teleport server's static directory
# Adjust path based on actual server installation
scp -r client/tp-player-web/ teleport-server:/opt/teleport/data/www/teleport/static/tp-player-web/
```

- [ ] **Step 2: Open player in browser**

Navigate to: `https://{server}/static/tp-player-web/index.html?rid={a_known_record_id}`

Verify:
1. Loading overlay shows progress
2. Recording metadata appears in top bar
3. Canvas renders the first frame
4. Playback starts automatically

- [ ] **Step 3: Test playback controls**

1. Click pause/play button — verify toggle works
2. Click progress bar at ~50% — verify seek to keyframe, then continues
3. Change speed to 4x — verify faster playback
4. Uncheck "跳过静默" — verify idle periods are not skipped
5. Press Space — verify pause/play toggle
6. Press ← / → — verify 10s skip

- [ ] **Step 4: Test zoom/pan**

1. Click "适应窗口" — canvas fits viewport
2. Click "1:1" — canvas at original resolution
3. Click "+" / "−" — verify zoom steps
4. Cmd+scroll (macOS) or Ctrl+scroll — verify smooth zoom
5. Click-drag on canvas while zoomed in — verify pan

- [ ] **Step 5: Test fault tolerance**

If a recording with known corruption is available, test that:
1. Playback does not stop on corrupt data
2. Console shows warning for skipped packets
3. Corrupt regions could be identified in console logs

- [ ] **Step 6: Test different resolutions**

Open recordings from different candidate machines (various screen resolutions). Verify:
1. Canvas resizes to match recording
2. Zoom "适应窗口" correctly scales all sizes
3. High-res recordings are readable when zoomed in

- [ ] **Step 7: Fix any issues found during testing, commit**

```bash
git add client/tp-player-web/
git commit -m "fix(tp-player-web): integration fixes from manual testing"
```

---

### Task 11: Final Polish and Documentation

**Files:**
- Modify: `client/tp-player-web/index.html` (if needed)
- Modify: `client/tp-player-web/css/player.css` (if needed)

- [ ] **Step 1: Verify all files are committed**

```bash
git status
git log --oneline -10
```

- [ ] **Step 2: Final commit**

```bash
git add client/tp-player-web/
git commit -m "feat(tp-player-web): complete browser-based RDP recording player

Replaces the Qt desktop tp-player with a browser-based alternative.
- Zoom/pan (25%-400%, Cmd/Ctrl+scroll, drag)
- Fault-tolerant playback (skips corrupt frames)
- Keyframe-based seek via .tpk index
- Speed control (1x-16x), skip-silence
- No TP-Assist dependency, cross-platform
- Parses new binary format (.tpr/.tpk/.tpd) in JS
- Uses pako.js (zlib) + rle.js WASM (RLE) for decompression"
```
