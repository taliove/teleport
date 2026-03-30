// Teleport RDP Web Player — Player (Playback Engine)
TPP.createPlayer = function(renderer, imageCache, callbacks) {
    var TYPE_RDP_POINTER = TPP.TYPE_RDP_POINTER;
    var TYPE_RDP_IMAGE = TPP.TYPE_RDP_IMAGE;
    var TYPE_RDP_KEYFRAME = TPP.TYPE_RDP_KEYFRAME;
    var RDP_IMG_ALT = TPP.RDP_IMG_ALT;
    var TICK_MS = TPP.TICK_MS;
    var SILENCE_THRESHOLD_MS = TPP.SILENCE_THRESHOLD_MS;

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
                var ptr = TPP.parsePointerPayload(dv, pkt.payloadOffset);
                renderer.updateCursor(ptr.x, ptr.y);
            } else if (pkt.type === TYPE_RDP_IMAGE) {
                var images = TPP.parseImagePayload(dv, pkt.payloadOffset, pkt.size);
                for (var i = 0; i < images.length; i++) {
                    var img = images[i];
                    if (img.format === RDP_IMG_ALT) {
                        var cached = imageCache.get(img.cacheIndex);
                        if (cached) renderer.renderImageTile(cached.rgba, img.destLeft, img.destTop, cached.width, cached.height);
                    } else {
                        var decoded = TPP.decodeImageTile(img);
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
                var kf = TPP.parseKeyframePayload(dv, pkt.payloadOffset, pkt.size);
                var rgba = TPP.decodeKeyframe(kf.data, renderer.width, renderer.height);
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
};
