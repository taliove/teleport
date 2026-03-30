// Teleport RDP Web Player — All-in-one bundle (classic script, no ES modules)
// This file is injected into the Teleport page by content-player.js.
// Because it runs in the page's main world, fetch() is same-origin and cookies work.

(function () {
    'use strict';

    // ========================================================================
    // Constants
    // ========================================================================

    var MAGIC_TPPR = 0x52505054;
    var HEADER_VER = 4;
    var TPPR_TYPE_RDP = 0x0101;
    var TPR_SIZE = 512;
    var HEADER_BASIC_OFFSET = 64;

    var TYPE_RDP_POINTER = 0x12;
    var TYPE_RDP_IMAGE = 0x13;
    var TYPE_RDP_KEYFRAME = 0x14;

    var RDP_IMG_RAW = 0;
    var RDP_IMG_BMP = 1;
    var RDP_IMG_ALT = 2;

    var PKG_HEADER_SIZE = 12;
    var IMAGE_INFO_SIZE = 24;
    var KEYFRAME_INFO_SIZE = 12;

    var MAX_RETRIES = 3;
    var RETRY_DELAY_MS = 1000;
    var FETCH_TIMEOUT_MS = 30000;
    var TICK_MS = 33;
    var SILENCE_THRESHOLD_MS = 1000;
    var LE = true;

    // ========================================================================
    // Downloader
    // ========================================================================

    function createDownloader(serverBase, rid) {
        function buildUrl(act, filename, extraParams) {
            var params = new URLSearchParams(
                Object.assign({ act: act, type: 'rdp', rid: String(rid), f: filename }, extraParams || {})
            );
            return serverBase + '/audit/get-file?' + params;
        }

        function fetchWithRetry(url, options, retries) {
            var retriesLeft = retries !== undefined ? retries : MAX_RETRIES;
            var controller = new AbortController();
            var timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
            return fetch(url, Object.assign({ credentials: 'include', signal: controller.signal }, options || {}))
                .then(function (resp) {
                    clearTimeout(timeoutId);
                    if (resp.status === 401 || resp.status === 403) {
                        throw Object.assign(new Error('认证已过期，请重新登录'), { code: 'AUTH_EXPIRED' });
                    }
                    if (resp.status === 416) return null;
                    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
                    return resp;
                })
                .catch(function (err) {
                    clearTimeout(timeoutId);
                    if (err.code === 'AUTH_EXPIRED' || retriesLeft <= 0) throw err;
                    if (err.name === 'AbortError' && retriesLeft <= 0) throw new Error('请求超时');
                    return new Promise(function (r) { setTimeout(r, RETRY_DELAY_MS); })
                        .then(function () { return fetchWithRetry(url, options, retriesLeft - 1); });
                });
        }

        function getFileSize(filename) {
            return fetchWithRetry(buildUrl('size', filename))
                .then(function (resp) { return resp.text(); })
                .then(function (text) {
                    var size = parseInt(text, 10);
                    if (isNaN(size) || size < 0) throw new Error('无效的文件大小: ' + text);
                    return size;
                });
        }

        function readFile(filename) {
            return fetchWithRetry(buildUrl('read', filename))
                .then(function (resp) { return resp ? resp.arrayBuffer() : null; });
        }

        function readFileWithProgress(filename, onProgress) {
            return getFileSize(filename).then(function (size) {
                return fetchWithRetry(buildUrl('read', filename)).then(function (resp) {
                    if (!resp) return null;
                    var reader = resp.body.getReader();
                    var chunks = [];
                    var received = 0;
                    function pump() {
                        return reader.read().then(function (result) {
                            if (result.done) return;
                            chunks.push(result.value);
                            received += result.value.byteLength;
                            if (onProgress) onProgress(received, size);
                            return pump();
                        });
                    }
                    return pump().then(function () {
                        var buf = new Uint8Array(received);
                        var offset = 0;
                        for (var i = 0; i < chunks.length; i++) {
                            buf.set(chunks[i], offset);
                            offset += chunks[i].byteLength;
                        }
                        return buf.buffer;
                    });
                });
            });
        }

        return { getFileSize: getFileSize, readFile: readFile, readFileWithProgress: readFileWithProgress };
    }

    // ========================================================================
    // Parser
    // ========================================================================

    function readCString(dv, offset, maxLen) {
        var bytes = [];
        for (var i = 0; i < maxLen; i++) {
            var b = dv.getUint8(offset + i);
            if (b === 0) break;
            bytes.push(b);
        }
        return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    }

    function parseHeader(buffer) {
        if (buffer.byteLength < TPR_SIZE) {
            throw Object.assign(new Error('文件头太短'), { code: 'INVALID_HEADER' });
        }
        var dv = new DataView(buffer);
        var magic = dv.getUint32(0, LE);
        if (magic !== MAGIC_TPPR) {
            throw Object.assign(new Error('无效的文件格式 (magic: 0x' + magic.toString(16) + ')'), { code: 'INVALID_MAGIC' });
        }
        var ver = dv.getUint16(4, LE);
        if (ver !== HEADER_VER) {
            throw Object.assign(new Error('不支持的版本: ' + ver + ' (需要 ' + HEADER_VER + ')'), { code: 'UNSUPPORTED_VER' });
        }
        var type = dv.getUint16(6, LE);
        if (type !== TPPR_TYPE_RDP) {
            throw Object.assign(new Error('不是 RDP 录制 (type: 0x' + type.toString(16) + ')'), { code: 'NOT_RDP' });
        }
        var B = HEADER_BASIC_OFFSET;
        return {
            timeMs: dv.getUint32(8, LE),
            datFileCount: dv.getUint32(12, LE),
            protocolType: dv.getUint16(B, LE),
            protocolSubType: dv.getUint16(B + 2, LE),
            timestamp: dv.getUint32(B + 4, LE),
            width: dv.getUint16(B + 12, LE),
            height: dv.getUint16(B + 14, LE),
            userUsername: readCString(dv, B + 16, 64),
            accUsername: readCString(dv, B + 80, 64),
            hostIp: readCString(dv, B + 144, 40),
            connIp: readCString(dv, B + 184, 40),
            connPort: dv.getUint16(B + 224, LE),
            clientIp: readCString(dv, B + 226, 40),
        };
    }

    function parseKeyframes(buffer) {
        var count = Math.floor(buffer.byteLength / KEYFRAME_INFO_SIZE);
        var dv = new DataView(buffer);
        var keyframes = [];
        for (var i = 0; i < count; i++) {
            var off = i * KEYFRAME_INFO_SIZE;
            keyframes.push({
                timeMs: dv.getUint32(off, LE),
                fileIndex: dv.getUint32(off + 4, LE),
                offset: dv.getUint32(off + 8, LE),
            });
        }
        return keyframes;
    }

    function parsePointerPayload(dv, offset) {
        return {
            x: dv.getUint16(offset, LE),
            y: dv.getUint16(offset + 2, LE),
            button: dv.getUint8(offset + 4),
            pressed: dv.getUint8(offset + 5),
        };
    }

    function parseImagePayload(dv, payloadOffset, payloadSize) {
        var count = dv.getUint16(payloadOffset, LE);
        var cursor = payloadOffset + 2;
        var endOffset = payloadOffset + payloadSize;
        var images = [];
        for (var i = 0; i < count && cursor < endOffset; i++) {
            if (cursor + IMAGE_INFO_SIZE > endOffset) break;
            var info = {
                destLeft: dv.getUint16(cursor, LE),
                destTop: dv.getUint16(cursor + 2, LE),
                destRight: dv.getUint16(cursor + 4, LE),
                destBottom: dv.getUint16(cursor + 6, LE),
                width: dv.getUint16(cursor + 8, LE),
                height: dv.getUint16(cursor + 10, LE),
                bitsPerPixel: dv.getUint16(cursor + 12, LE),
                format: dv.getUint8(cursor + 14),
                datLen: dv.getUint32(cursor + 16, LE),
                zipLen: dv.getUint32(cursor + 20, LE),
            };
            cursor += IMAGE_INFO_SIZE;
            if (info.format === RDP_IMG_ALT) {
                images.push(Object.assign({}, info, { data: null, cacheIndex: info.datLen }));
            } else {
                var dataLen = info.zipLen > 0 ? info.zipLen : info.datLen;
                if (cursor + dataLen > endOffset) break;
                var data = new Uint8Array(dv.buffer, dv.byteOffset + cursor, dataLen);
                images.push(Object.assign({}, info, { data: new Uint8Array(data) }));
                cursor += dataLen;
            }
        }
        return images;
    }

    function parseKeyframePayload(dv, payloadOffset, payloadSize) {
        var info = {
            timeMs: dv.getUint32(payloadOffset, LE),
            fileIndex: dv.getUint32(payloadOffset + 4, LE),
            offset: dv.getUint32(payloadOffset + 8, LE),
        };
        var dataOffset = payloadOffset + KEYFRAME_INFO_SIZE;
        var dataLen = payloadSize - KEYFRAME_INFO_SIZE;
        var data = new Uint8Array(dv.buffer, dv.byteOffset + dataOffset, dataLen);
        return { info: info, data: new Uint8Array(data) };
    }

    function iteratePackets(buffer, corruptedRanges) {
        var dv = new DataView(buffer);
        var totalLen = buffer.byteLength;
        var pos = 0;
        var packets = [];
        while (pos + PKG_HEADER_SIZE <= totalLen) {
            try {
                var type = dv.getUint8(pos);
                var size = dv.getUint32(pos + 1, LE);
                var timeMs = dv.getUint32(pos + 5, LE);
                var payloadOffset = pos + PKG_HEADER_SIZE;
                var validType = (type === TYPE_RDP_POINTER || type === TYPE_RDP_IMAGE || type === TYPE_RDP_KEYFRAME);
                var validSize = (payloadOffset + size <= totalLen) && (size < 50 * 1024 * 1024);
                if (!validType || !validSize) throw new Error('invalid packet');
                packets.push({ type: type, size: size, timeMs: timeMs, payloadOffset: payloadOffset, buffer: buffer });
                pos = payloadOffset + size;
            } catch (e) {
                var corruptStart = pos;
                var sizeField = pos + 5 <= totalLen ? dv.getUint32(pos + 1, LE) : 0;
                if (sizeField > 0 && sizeField < totalLen && pos + PKG_HEADER_SIZE + sizeField <= totalLen) {
                    pos = pos + PKG_HEADER_SIZE + sizeField;
                } else {
                    pos++;
                    while (pos + PKG_HEADER_SIZE <= totalLen) {
                        var t = dv.getUint8(pos);
                        if (t === TYPE_RDP_POINTER || t === TYPE_RDP_IMAGE || t === TYPE_RDP_KEYFRAME) {
                            var s = dv.getUint32(pos + 1, LE);
                            if (s > 0 && s < 50 * 1024 * 1024 && pos + PKG_HEADER_SIZE + s <= totalLen) break;
                        }
                        pos++;
                    }
                }
                if (corruptedRanges) {
                    corruptedRanges.push({ startOffset: corruptStart, endOffset: pos });
                }
            }
        }
        return packets;
    }

    // ========================================================================
    // Decoder
    // ========================================================================

    var wasmReady = false;
    var wasmReadyPromise = null;

    function initDecoder() {
        if (wasmReadyPromise) return wasmReadyPromise;
        wasmReadyPromise = new Promise(function (resolve) {
            if (typeof Module !== 'undefined' && Module.calledRun) { wasmReady = true; resolve(); return; }
            var origOnInit = (typeof Module !== 'undefined' && Module.onRuntimeInitialized) || null;
            if (typeof Module === 'undefined') window.Module = {};
            Module.onRuntimeInitialized = function () {
                wasmReady = true;
                if (origOnInit) origOnInit();
                resolve();
            };
            if (typeof Module !== 'undefined' && Module.calledRun) { wasmReady = true; resolve(); }
        });
        return wasmReadyPromise;
    }

    function zlibDecompress(compressedData) {
        return pako.inflate(compressedData);
    }

    function rleDecompress(inputData, width, height, bitsPerPixel) {
        if (!wasmReady) throw new Error('WASM RLE module not ready');
        var funcName = bitsPerPixel === 15 ? 'bitmap_decompress_15' : 'bitmap_decompress_16';
        var outputSize = width * height * 4;
        var inputSize = inputData.byteLength;
        var outPtr = Module._malloc(outputSize);
        var inPtr = Module._malloc(inputSize);
        Module.HEAPU8.set(inputData, inPtr);
        try {
            Module.ccall(funcName, 'number',
                ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
                [outPtr, width, height, width, height, inPtr, inputSize]);
            var output = new Uint8ClampedArray(outputSize);
            output.set(new Uint8Array(Module.HEAPU8.buffer, outPtr, outputSize));
            return output;
        } finally {
            Module._free(outPtr);
            Module._free(inPtr);
        }
    }

    function rgb565ToRgba(input, width, height) {
        var pixelCount = width * height;
        var output = new Uint8ClampedArray(pixelCount * 4);
        var srcView = new DataView(input.buffer, input.byteOffset, input.byteLength);
        for (var i = 0; i < pixelCount; i++) {
            var pixel = srcView.getUint16(i * 2, true);
            var j = i * 4;
            output[j] = ((pixel >> 11) & 0x1F) * 255 / 31 | 0;
            output[j + 1] = ((pixel >> 5) & 0x3F) * 255 / 63 | 0;
            output[j + 2] = (pixel & 0x1F) * 255 / 31 | 0;
            output[j + 3] = 255;
        }
        return output;
    }

    function rgb555ToRgba(input, width, height) {
        var pixelCount = width * height;
        var output = new Uint8ClampedArray(pixelCount * 4);
        var srcView = new DataView(input.buffer, input.byteOffset, input.byteLength);
        for (var i = 0; i < pixelCount; i++) {
            var pixel = srcView.getUint16(i * 2, true);
            var j = i * 4;
            output[j] = ((pixel >> 10) & 0x1F) * 255 / 31 | 0;
            output[j + 1] = ((pixel >> 5) & 0x1F) * 255 / 31 | 0;
            output[j + 2] = (pixel & 0x1F) * 255 / 31 | 0;
            output[j + 3] = 255;
        }
        return output;
    }

    function flipVertical(rgba, width, height) {
        var rowBytes = width * 4;
        var temp = new Uint8ClampedArray(rowBytes);
        for (var y = 0; y < Math.floor(height / 2); y++) {
            var topOff = y * rowBytes;
            var botOff = (height - 1 - y) * rowBytes;
            temp.set(rgba.subarray(topOff, topOff + rowBytes));
            rgba.copyWithin(topOff, botOff, botOff + rowBytes);
            rgba.set(temp, botOff);
        }
    }

    function decodeImageTile(imageInfo) {
        var data = imageInfo.data, width = imageInfo.width, height = imageInfo.height;
        var bitsPerPixel = imageInfo.bitsPerPixel, format = imageInfo.format;
        var zipLen = imageInfo.zipLen;

        if (format === RDP_IMG_RAW) {
            var pixelData = data;
            if (zipLen > 0) pixelData = zlibDecompress(data);
            var rgba = bitsPerPixel === 15 ? rgb555ToRgba(pixelData, width, height) : rgb565ToRgba(pixelData, width, height);
            flipVertical(rgba, width, height);
            return { rgba: rgba, width: width, height: height };
        }
        if (format === RDP_IMG_BMP) {
            var rleData = data;
            if (zipLen > 0) rleData = zlibDecompress(data);
            var rgba2 = rleDecompress(new Uint8Array(rleData), width, height, bitsPerPixel);
            return { rgba: rgba2, width: width, height: height };
        }
        return null;
    }

    function decodeKeyframe(data, width, height) {
        var expectedSize = width * height * 2;
        var pixelData = data;
        if (data.byteLength !== expectedSize) pixelData = zlibDecompress(data);
        if (pixelData.byteLength < expectedSize) {
            throw new Error('Keyframe data too short: got ' + pixelData.byteLength + ', expected ' + expectedSize);
        }
        return rgb565ToRgba(new Uint8Array(pixelData), width, height);
    }

    // ========================================================================
    // Image Cache
    // ========================================================================

    function createImageCache() {
        var entries = [];
        return {
            push: function (entry) { entries.push(entry); },
            get: function (index) { return (index >= 0 && index < entries.length) ? entries[index] : null; },
            clear: function () { entries = []; },
        };
    }

    // ========================================================================
    // Renderer
    // ========================================================================

    function createRenderer(displayCanvas) {
        var displayCtx = displayCanvas.getContext('2d');
        var backbuffer = null, backCtx = null;
        var screenWidth = 0, screenHeight = 0;
        var cursorX = 0, cursorY = 0;
        var CURSOR_RADIUS = 5;

        function init(width, height) {
            screenWidth = width; screenHeight = height;
            displayCanvas.width = width; displayCanvas.height = height;
            backbuffer = new OffscreenCanvas(width, height);
            backCtx = backbuffer.getContext('2d');
            backCtx.fillStyle = '#263f6f';
            backCtx.fillRect(0, 0, width, height);
            flush();
        }
        function renderImageTile(rgba, destLeft, destTop, w, h) {
            if (!backCtx) return;
            backCtx.putImageData(new ImageData(rgba, w, h), destLeft, destTop);
        }
        function renderKeyframe(rgba, w, h) {
            if (!backCtx) return;
            backCtx.putImageData(new ImageData(rgba, w, h), 0, 0);
        }
        function updateCursor(x, y) { cursorX = x; cursorY = y; }
        function flush() {
            if (!backbuffer) return;
            displayCtx.drawImage(backbuffer, 0, 0);
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
            if (backCtx) { backCtx.fillStyle = '#263f6f'; backCtx.fillRect(0, 0, screenWidth, screenHeight); }
            flush();
        }
        return {
            init: init, renderImageTile: renderImageTile, renderKeyframe: renderKeyframe,
            updateCursor: updateCursor, flush: flush, clear: clear,
            get width() { return screenWidth; }, get height() { return screenHeight; },
        };
    }

    // ========================================================================
    // Player (Playback Engine)
    // ========================================================================

    function createPlayer(renderer, imageCache, callbacks) {
        var packets = [], keyframes = [], totalMs = 0, currentMs = 0, packetIndex = 0;
        var speed = 1, skipSilence = true, playing = false, timerId = null;

        function load(pp, kf, dur) { packets = pp; keyframes = kf; totalMs = dur; currentMs = 0; packetIndex = 0; }

        function updatePackets(pp, kf, dur) {
            var prevMs = currentMs;
            packets = pp; keyframes = kf; totalMs = dur;
            packetIndex = findPacketIndex(prevMs);
            while (packetIndex < packets.length && packets[packetIndex].timeMs < prevMs) packetIndex++;
        }

        function play() { if (playing) return; playing = true; scheduleTick(); }
        function pause() {
            playing = false;
            if (timerId !== null) { cancelAnimationFrame(timerId); timerId = null; }
        }
        function togglePlayPause() { if (playing) pause(); else play(); return playing; }
        function setSpeed(s) { speed = s; }
        function setSkipSilence(skip) { skipSilence = skip; }

        function seek(targetMs) {
            pause();
            var kfIndex = -1;
            for (var i = keyframes.length - 1; i >= 0; i--) {
                if (keyframes[i].timeMs <= targetMs) { kfIndex = i; break; }
            }
            imageCache.clear();
            packetIndex = kfIndex >= 0 ? findPacketIndex(keyframes[kfIndex].timeMs) : 0;
            currentMs = (packets.length > 0 && packetIndex < packets.length) ? packets[packetIndex].timeMs : 0;
            while (packetIndex < packets.length && packets[packetIndex].timeMs <= targetMs) {
                processPacket(packetIndex); packetIndex++;
            }
            currentMs = targetMs;
            renderer.flush();
            if (callbacks.onProgress) callbacks.onProgress(currentMs, totalMs);
        }

        function findPacketIndex(timeMs) {
            var lo = 0, hi = packets.length;
            while (lo < hi) { var mid = (lo + hi) >>> 1; if (packets[mid].timeMs < timeMs) lo = mid + 1; else hi = mid; }
            return lo;
        }

        function scheduleTick() { if (playing) timerId = requestAnimationFrame(tick); }

        function tick() {
            if (!playing) return;
            var advanceMs = TICK_MS * speed;
            var nextMs = currentMs + advanceMs;
            if (skipSilence && packetIndex < packets.length) {
                var npt = packets[packetIndex].timeMs;
                if (npt - currentMs > SILENCE_THRESHOLD_MS) nextMs = npt;
            }
            var rendered = false;
            while (packetIndex < packets.length && packets[packetIndex].timeMs <= nextMs) {
                processPacket(packetIndex); packetIndex++; rendered = true;
            }
            currentMs = Math.min(nextMs, totalMs);
            if (rendered) renderer.flush();
            if (callbacks.onProgress) callbacks.onProgress(currentMs, totalMs);
            if (packetIndex >= packets.length && currentMs >= totalMs) {
                playing = false; if (callbacks.onEnd) callbacks.onEnd(); return;
            }
            scheduleTick();
        }

        function processPacket(index) {
            var pkt = packets[index];
            var dv = new DataView(pkt.buffer);
            try {
                if (pkt.type === TYPE_RDP_POINTER) {
                    var ptr = parsePointerPayload(dv, pkt.payloadOffset);
                    renderer.updateCursor(ptr.x, ptr.y);
                } else if (pkt.type === TYPE_RDP_IMAGE) {
                    var images = parseImagePayload(dv, pkt.payloadOffset, pkt.size);
                    for (var i = 0; i < images.length; i++) {
                        var img = images[i];
                        if (img.format === RDP_IMG_ALT) {
                            var cached = imageCache.get(img.cacheIndex);
                            if (cached) renderer.renderImageTile(cached.rgba, img.destLeft, img.destTop, cached.width, cached.height);
                        } else {
                            var decoded = decodeImageTile(img);
                            if (decoded) {
                                var destW = img.destRight - img.destLeft + 1;
                                var destH = img.destBottom - img.destTop + 1;
                                imageCache.push({ rgba: decoded.rgba, width: destW, height: destH, destLeft: img.destLeft, destTop: img.destTop });
                                renderer.renderImageTile(decoded.rgba, img.destLeft, img.destTop, destW, destH);
                            }
                        }
                    }
                } else if (pkt.type === TYPE_RDP_KEYFRAME) {
                    imageCache.clear();
                    var kf = parseKeyframePayload(dv, pkt.payloadOffset, pkt.size);
                    var rgba = decodeKeyframe(kf.data, renderer.width, renderer.height);
                    renderer.renderKeyframe(rgba, renderer.width, renderer.height);
                }
            } catch (err) {
                console.warn('Packet #' + index + ' (type=0x' + pkt.type.toString(16) + ', time=' + pkt.timeMs + 'ms) decode error:', err);
            }
        }

        return {
            load: load, updatePackets: updatePackets, play: play, pause: pause,
            togglePlayPause: togglePlayPause, seek: seek, setSpeed: setSpeed, setSkipSilence: setSkipSilence,
            get playing() { return playing; }, get currentMs() { return currentMs; }, get totalMs() { return totalMs; },
        };
    }

    // ========================================================================
    // Zoom & Pan
    // ========================================================================

    function createZoomController(canvasWrapper, canvasContainer, displayEl) {
        var scale = 1.0, panX = 0, panY = 0, canvasWidth = 0, canvasHeight = 0, fitMode = true;
        var MIN_SCALE = 0.25, MAX_SCALE = 4.0, STEP = 0.25;
        var dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;

        function init(w, h) { canvasWidth = w; canvasHeight = h; fitToWindow(); }
        function setScale(s) { fitMode = false; scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); applyTransform(); updateDisplay(); }
        function fitToWindow() {
            fitMode = true;
            var r = canvasContainer.getBoundingClientRect();
            scale = Math.min(r.width / canvasWidth, r.height / canvasHeight, 1.0);
            panX = 0; panY = 0; applyTransform(); updateDisplay();
        }
        function originalSize() { fitMode = false; scale = 1.0; panX = 0; panY = 0; applyTransform(); updateDisplay(); }
        function zoomIn() { setScale(scale + STEP); }
        function zoomOut() { setScale(scale - STEP); }
        function applyTransform() {
            var r = canvasContainer.getBoundingClientRect();
            var ox = Math.max(0, (r.width - canvasWidth * scale) / 2);
            var oy = Math.max(0, (r.height - canvasHeight * scale) / 2);
            canvasWrapper.style.transform = 'translate(' + (ox + panX) + 'px, ' + (oy + panY) + 'px) scale(' + scale + ')';
        }
        function updateDisplay() { if (displayEl) displayEl.textContent = Math.round(scale * 100) + '%'; }
        function handleResize() { if (fitMode) fitToWindow(); else applyTransform(); }

        canvasContainer.addEventListener('wheel', function (e) {
            if (e.metaKey || e.ctrlKey) { e.preventDefault(); setScale(scale + (e.deltaY > 0 ? -STEP : STEP)); }
        }, { passive: false });
        canvasWrapper.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            dragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
            panStartX = panX; panStartY = panY; canvasWrapper.classList.add('dragging');
        });
        window.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            panX = panStartX + (e.clientX - dragStartX); panY = panStartY + (e.clientY - dragStartY);
            applyTransform();
        });
        window.addEventListener('mouseup', function () {
            if (!dragging) return; dragging = false; canvasWrapper.classList.remove('dragging');
        });

        return { init: init, fitToWindow: fitToWindow, originalSize: originalSize, zoomIn: zoomIn, zoomOut: zoomOut, handleResize: handleResize };
    }

    // ========================================================================
    // App — Entry Point
    // ========================================================================

    var rid = window.__TP_RID || new URLSearchParams(location.search).get('rid');
    var serverBase = window.__TP_SERVER || location.origin;

    if (!rid) {
        showError('缺少参数: rid (录制ID)');
        return;
    }

    // --- DOM references ---
    var canvas = document.getElementById('player-canvas');
    var canvasWrapper = document.getElementById('canvas-wrapper');
    var canvasContainer = document.getElementById('canvas-container');
    var loadingOverlay = document.getElementById('loading-overlay');
    var loadingText = document.getElementById('loading-text');
    var loadingProgress = document.getElementById('loading-progress');
    var errorOverlay = document.getElementById('error-overlay');
    var errorText = document.getElementById('error-text');
    var metaInfo = document.getElementById('meta-info');
    var btnPlay = document.getElementById('btn-play');
    var speedGroup = document.getElementById('speed-group');
    var speedBtns = speedGroup.querySelectorAll('.seg-btn');
    var skipToggle = document.getElementById('skip-toggle');
    var skipGroup = document.getElementById('skip-group');
    var progressContainer = document.getElementById('progress-container');
    var progressPlayed = document.getElementById('progress-played');
    var progressHandle = document.getElementById('progress-handle');
    var progressBar = document.getElementById('progress-bar');
    var timeDisplay = document.getElementById('time-display');
    var btnFit = document.getElementById('btn-fit');
    var btnOriginal = document.getElementById('btn-original');
    var btnZoomIn = document.getElementById('btn-zoom-in');
    var btnZoomOut = document.getElementById('btn-zoom-out');
    var zoomDisplay = document.getElementById('zoom-display');
    var errorRetry = document.getElementById('error-retry');
    var toastContainer = document.getElementById('toast-container');

    // --- Core instances ---
    var downloader = createDownloader(serverBase, rid);
    var imageCache = createImageCache();
    var renderer = createRenderer(canvas);
    var zoom = createZoomController(canvasWrapper, canvasContainer, zoomDisplay);

    var player = createPlayer(renderer, imageCache, {
        onProgress: function (cur, total) { updateProgressBar(cur, total); },
        onEnd: function () { btnPlay.textContent = '\u25B6'; },
        onError: function (err) { console.error('Playback error:', err); },
    });

    // --- Preferences (localStorage) ---
    var PREFS_KEY = 'tp_player_prefs';
    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function savePrefs(update) {
        try {
            var prefs = Object.assign(loadPrefs(), update);
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (e) { /* quota or private mode */ }
    }

    // Apply saved preferences to UI
    var savedPrefs = loadPrefs();
    if (savedPrefs.speed) {
        for (var pi = 0; pi < speedBtns.length; pi++) {
            var isActive = parseInt(speedBtns[pi].getAttribute('data-speed'), 10) === savedPrefs.speed;
            speedBtns[pi].classList.toggle('active', isActive);
        }
        player.setSpeed(savedPrefs.speed);
    }
    if (savedPrefs.skipSilence !== undefined) {
        skipToggle.classList.toggle('active', savedPrefs.skipSilence);
        player.setSkipSilence(savedPrefs.skipSilence);
    }

    // --- Helpers ---
    function formatTime(ms) {
        var sec = Math.floor(ms / 1000);
        var m = Math.floor(sec / 60), s = sec % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updateProgressBar(cur, total) {
        var pct = total > 0 ? (cur / total) * 100 : 0;
        progressPlayed.style.width = pct + '%';
        progressHandle.style.left = pct + '%';
        timeDisplay.textContent = formatTime(cur) + ' / ' + formatTime(total);
    }

    function showError(msg) {
        loadingOverlay.style.display = 'none';
        errorOverlay.style.display = 'flex';
        errorText.textContent = msg;
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

    function showToast(msg, type) {
        var toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');
        toast.textContent = msg;
        toastContainer.appendChild(toast);
        setTimeout(function () {
            toast.classList.add('hiding');
            setTimeout(function () { toast.remove(); }, 300);
        }, 4000);
    }

    function renderCorruptMarks(corruptedRanges, pkts, total) {
        progressBar.querySelectorAll('.corrupt-mark').forEach(function (el) { el.remove(); });
        if (corruptedRanges.length === 0 || total <= 0) return;
        for (var r = 0; r < corruptedRanges.length; r++) {
            var range = corruptedRanges[r];
            var startMs = 0, endMs = total;
            for (var p = 0; p < pkts.length; p++) {
                if (pkts[p].payloadOffset <= range.startOffset) startMs = pkts[p].timeMs;
                if (pkts[p].payloadOffset >= range.endOffset) { endMs = pkts[p].timeMs; break; }
            }
            var mark = document.createElement('div');
            mark.className = 'corrupt-mark';
            mark.style.left = ((startMs / total) * 100) + '%';
            mark.style.width = Math.max(0.5, ((endMs - startMs) / total) * 100) + '%';
            mark.title = '损坏区域: ' + formatTime(startMs) + ' - ' + formatTime(endMs);
            progressBar.appendChild(mark);
        }
    }

    // --- Speed control ---
    function setActiveSpeed(targetBtn) {
        for (var i = 0; i < speedBtns.length; i++) speedBtns[i].classList.remove('active');
        targetBtn.classList.add('active');
        player.setSpeed(parseInt(targetBtn.getAttribute('data-speed'), 10));
    }

    function cycleSpeed(dir) {
        var activeIdx = -1;
        for (var i = 0; i < speedBtns.length; i++) {
            if (speedBtns[i].classList.contains('active')) { activeIdx = i; break; }
        }
        var nextIdx = activeIdx + dir;
        if (nextIdx >= 0 && nextIdx < speedBtns.length) setActiveSpeed(speedBtns[nextIdx]);
    }

    // --- Zoom active-state tracking ---
    function updateZoomBtnState(mode) {
        btnFit.classList.toggle('active', mode === 'fit');
        btnOriginal.classList.toggle('active', mode === '1:1');
    }

    // --- Init & load ---
    function init() {
        showLoading('正在加载 WASM 模块...');
        initDecoder().then(function () {
            showLoading('正在下载录制头...');
            return downloader.readFile('tp-rdp.tpr');
        }).then(function (tprBuf) {
            if (!tprBuf) throw new Error('无法下载 tp-rdp.tpr');
            var header = parseHeader(tprBuf);
            metaInfo.textContent = 'RDP 录屏回放 — ' + header.accUsername + '@' + header.hostIp + ' (' + header.userUsername + ')';
            document.title = 'RDP 回放 — ' + header.accUsername + '@' + header.hostIp;
            renderer.init(header.width, header.height);
            zoom.init(header.width, header.height);

            // Apply saved zoom mode
            if (savedPrefs.zoomMode === '1:1') {
                zoom.originalSize();
                updateZoomBtnState('1:1');
            } else {
                updateZoomBtnState('fit');
            }

            showLoading('正在下载关键帧索引...');
            return downloader.readFile('tp-rdp.tpk').then(function (tpkBuf) {
                var keyframes = tpkBuf ? parseKeyframes(tpkBuf) : [];
                return { header: header, keyframes: keyframes };
            });
        }).then(function (ctx) {
            var header = ctx.header, keyframes = ctx.keyframes;
            var allPackets = [], corruptedRanges = [];

            if (header.datFileCount > 0) {
                showLoading('正在下载数据文件 1/' + header.datFileCount + '...', '');
                return downloader.readFileWithProgress('tp-rdp-1.tpd', function (received, total) {
                    var pct = total > 0 ? Math.round(received / total * 100) : 0;
                    loadingProgress.textContent = pct + '% (' + (received / 1024 / 1024).toFixed(1) + ' MB)';
                }).then(function (firstBuf) {
                    if (firstBuf) {
                        var pkts = iteratePackets(firstBuf, corruptedRanges);
                        for (var i = 0; i < pkts.length; i++) allPackets.push(pkts[i]);
                    }
                    allPackets.sort(function (a, b) { return a.timeMs - b.timeMs; });
                    player.load(allPackets, keyframes, header.timeMs);
                    renderCorruptMarks(corruptedRanges, allPackets, header.timeMs);

                    // Seek to first keyframe to get a clean initial frame (avoids garbled tiles)
                    var firstKfTime = -1;
                    for (var fi = 0; fi < allPackets.length; fi++) {
                        if (allPackets[fi].type === TYPE_RDP_KEYFRAME) {
                            firstKfTime = allPackets[fi].timeMs;
                            break;
                        }
                    }
                    if (firstKfTime >= 0) {
                        player.seek(firstKfTime);
                    }

                    updateProgressBar(player.currentMs, header.timeMs);
                    hideOverlays();
                    player.play();
                    btnPlay.textContent = '\u23F8';

                    if (corruptedRanges.length > 0) {
                        showToast('检测到 ' + corruptedRanges.length + ' 处数据损坏，已自动跳过', 'warning');
                    }

                    // Background-download remaining files (non-blocking)
                    var chain = Promise.resolve();
                    for (var f = 2; f <= header.datFileCount; f++) {
                        (function (idx) {
                            chain = chain.then(function () {
                                return downloader.readFileWithProgress('tp-rdp-' + idx + '.tpd', function () {}).then(function (buf) {
                                    if (!buf) {
                                        showToast('数据文件 ' + idx + ' 不存在，已跳过', 'warning');
                                        return;
                                    }
                                    var pkts = iteratePackets(buf, corruptedRanges);
                                    for (var j = 0; j < pkts.length; j++) allPackets.push(pkts[j]);
                                    allPackets.sort(function (a, b) { return a.timeMs - b.timeMs; });
                                    player.updatePackets(allPackets, keyframes, header.timeMs);
                                    renderCorruptMarks(corruptedRanges, allPackets, header.timeMs);
                                }).catch(function (err) {
                                    showToast('数据文件 ' + idx + ' 加载失败: ' + err.message, 'warning');
                                });
                            });
                        })(f);
                    }
                    return chain;
                });
            }
            hideOverlays();
        }).catch(function (err) {
            console.error('Init error:', err);
            if (err.code === 'AUTH_EXPIRED') showError('认证已过期，请重新登录后再试');
            else showError('加载失败: ' + err.message);
        });
    }

    // --- UI event handlers ---

    // Play/Pause
    btnPlay.addEventListener('click', function () {
        btnPlay.textContent = player.togglePlayPause() ? '\u23F8' : '\u25B6';
    });

    // Segmented speed control
    for (var si = 0; si < speedBtns.length; si++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                setActiveSpeed(btn);
                savePrefs({ speed: parseInt(btn.getAttribute('data-speed'), 10) });
            });
        })(speedBtns[si]);
    }

    // Toggle switch — skip silence
    skipGroup.addEventListener('click', function () {
        skipToggle.classList.toggle('active');
        var isActive = skipToggle.classList.contains('active');
        player.setSkipSilence(isActive);
        savePrefs({ skipSilence: isActive });
    });

    // Progress bar seek
    var seeking = false, wasPlayingBeforeSeek = false;
    progressContainer.addEventListener('mousedown', function (e) {
        seeking = true;
        wasPlayingBeforeSeek = player.playing;
        player.pause();
        progressHandle.classList.add('active');
        seekToPosition(e);
    });
    window.addEventListener('mousemove', function (e) { if (seeking) seekToPosition(e); });
    window.addEventListener('mouseup', function () {
        if (seeking) {
            seeking = false;
            progressHandle.classList.remove('active');
            if (wasPlayingBeforeSeek) { player.play(); btnPlay.textContent = '\u23F8'; }
        }
    });
    function seekToPosition(e) {
        var rect = progressBar.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        player.seek(pct * player.totalMs);
    }

    // Zoom buttons
    btnFit.addEventListener('click', function () { zoom.fitToWindow(); updateZoomBtnState('fit'); savePrefs({ zoomMode: 'fit' }); });
    btnOriginal.addEventListener('click', function () { zoom.originalSize(); updateZoomBtnState('1:1'); savePrefs({ zoomMode: '1:1' }); });
    btnZoomIn.addEventListener('click', function () { zoom.zoomIn(); updateZoomBtnState(null); });
    btnZoomOut.addEventListener('click', function () { zoom.zoomOut(); updateZoomBtnState(null); });

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.code) {
            case 'Space':
                e.preventDefault(); btnPlay.click(); break;
            case 'ArrowLeft':
                e.preventDefault();
                var wl = player.playing;
                player.seek(Math.max(0, player.currentMs - 10000));
                if (wl) player.play();
                break;
            case 'ArrowRight':
                e.preventDefault();
                var wr = player.playing;
                player.seek(Math.min(player.totalMs, player.currentMs + 10000));
                if (wr) player.play();
                break;
            case 'Equal': case 'NumpadAdd':
                e.preventDefault(); cycleSpeed(1); break;
            case 'Minus': case 'NumpadSubtract':
                e.preventDefault(); cycleSpeed(-1); break;
        }
    });

    // Retry & resize
    errorRetry.addEventListener('click', function () { init(); });
    window.addEventListener('resize', function () { zoom.handleResize(); });

    init();
})();
