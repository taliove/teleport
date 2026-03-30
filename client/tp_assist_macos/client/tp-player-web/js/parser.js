// Binary format parser for .tpr / .tpk / .tpd files
// Reference: client/tp-player/record_format.h (all structs are #pragma pack(push,1))

import {
    MAGIC_TPPR, HEADER_VER, TPPR_TYPE_RDP,
    TPR_SIZE, HEADER_BASIC_OFFSET,
    TYPE_RDP_POINTER, TYPE_RDP_IMAGE, TYPE_RDP_KEYFRAME,
    PKG_HEADER_SIZE, IMAGE_INFO_SIZE, KEYFRAME_INFO_SIZE,
    RDP_IMG_ALT,
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
