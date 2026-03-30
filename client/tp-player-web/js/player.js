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
