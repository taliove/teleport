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
window.addEventListener('resize', () => zoom.handleResize());

// Start
init();
