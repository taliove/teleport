// Teleport RDP Web Player — Parser

TPP.readCString = function(dv, offset, maxLen) {
    var bytes = [];
    for (var i = 0; i < maxLen; i++) {
        var b = dv.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
};

TPP.parseHeader = function(buffer) {
    if (buffer.byteLength < TPP.TPR_SIZE) {
        throw Object.assign(new Error('\u6587\u4ef6\u5934\u592a\u77ed'), { code: 'INVALID_HEADER' });
    }
    var dv = new DataView(buffer);
    var magic = dv.getUint32(0, TPP.LE);
    if (magic !== TPP.MAGIC_TPPR) {
        throw Object.assign(new Error('\u65e0\u6548\u7684\u6587\u4ef6\u683c\u5f0f (magic: 0x' + magic.toString(16) + ')'), { code: 'INVALID_MAGIC' });
    }
    var ver = dv.getUint16(4, TPP.LE);
    if (ver !== TPP.HEADER_VER) {
        throw Object.assign(new Error('\u4e0d\u652f\u6301\u7684\u7248\u672c: ' + ver + ' (\u9700\u8981 ' + TPP.HEADER_VER + ')'), { code: 'UNSUPPORTED_VER' });
    }
    var type = dv.getUint16(6, TPP.LE);
    if (type !== TPP.TPPR_TYPE_RDP) {
        throw Object.assign(new Error('\u4e0d\u662f RDP \u5f55\u5236 (type: 0x' + type.toString(16) + ')'), { code: 'NOT_RDP' });
    }
    var B = TPP.HEADER_BASIC_OFFSET;
    return {
        timeMs: dv.getUint32(8, TPP.LE),
        datFileCount: dv.getUint32(12, TPP.LE),
        protocolType: dv.getUint16(B, TPP.LE),
        protocolSubType: dv.getUint16(B + 2, TPP.LE),
        timestamp: dv.getUint32(B + 4, TPP.LE),
        width: dv.getUint16(B + 12, TPP.LE),
        height: dv.getUint16(B + 14, TPP.LE),
        userUsername: TPP.readCString(dv, B + 16, 64),
        accUsername: TPP.readCString(dv, B + 80, 64),
        hostIp: TPP.readCString(dv, B + 144, 40),
        connIp: TPP.readCString(dv, B + 184, 40),
        connPort: dv.getUint16(B + 224, TPP.LE),
        clientIp: TPP.readCString(dv, B + 226, 40),
    };
};

TPP.parseKeyframes = function(buffer) {
    var count = Math.floor(buffer.byteLength / TPP.KEYFRAME_INFO_SIZE);
    var dv = new DataView(buffer);
    var keyframes = [];
    for (var i = 0; i < count; i++) {
        var off = i * TPP.KEYFRAME_INFO_SIZE;
        keyframes.push({
            timeMs: dv.getUint32(off, TPP.LE),
            fileIndex: dv.getUint32(off + 4, TPP.LE),
            offset: dv.getUint32(off + 8, TPP.LE),
        });
    }
    return keyframes;
};

TPP.parsePointerPayload = function(dv, offset) {
    return {
        x: dv.getUint16(offset, TPP.LE),
        y: dv.getUint16(offset + 2, TPP.LE),
        button: dv.getUint8(offset + 4),
        pressed: dv.getUint8(offset + 5),
    };
};

TPP.parseImagePayload = function(dv, payloadOffset, payloadSize) {
    var count = dv.getUint16(payloadOffset, TPP.LE);
    var cursor = payloadOffset + 2;
    var endOffset = payloadOffset + payloadSize;
    var images = [];
    for (var i = 0; i < count && cursor < endOffset; i++) {
        if (cursor + TPP.IMAGE_INFO_SIZE > endOffset) break;
        var info = {
            destLeft: dv.getUint16(cursor, TPP.LE),
            destTop: dv.getUint16(cursor + 2, TPP.LE),
            destRight: dv.getUint16(cursor + 4, TPP.LE),
            destBottom: dv.getUint16(cursor + 6, TPP.LE),
            width: dv.getUint16(cursor + 8, TPP.LE),
            height: dv.getUint16(cursor + 10, TPP.LE),
            bitsPerPixel: dv.getUint16(cursor + 12, TPP.LE),
            format: dv.getUint8(cursor + 14),
            datLen: dv.getUint32(cursor + 16, TPP.LE),
            zipLen: dv.getUint32(cursor + 20, TPP.LE),
        };
        cursor += TPP.IMAGE_INFO_SIZE;
        if (info.format === TPP.RDP_IMG_ALT) {
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
};

TPP.parseKeyframePayload = function(dv, payloadOffset, payloadSize) {
    var info = {
        timeMs: dv.getUint32(payloadOffset, TPP.LE),
        fileIndex: dv.getUint32(payloadOffset + 4, TPP.LE),
        offset: dv.getUint32(payloadOffset + 8, TPP.LE),
    };
    var dataOffset = payloadOffset + TPP.KEYFRAME_INFO_SIZE;
    var dataLen = payloadSize - TPP.KEYFRAME_INFO_SIZE;
    var data = new Uint8Array(dv.buffer, dv.byteOffset + dataOffset, dataLen);
    return { info: info, data: new Uint8Array(data) };
};

TPP.iteratePackets = function(buffer, corruptedRanges) {
    var dv = new DataView(buffer);
    var totalLen = buffer.byteLength;
    var pos = 0;
    var packets = [];
    while (pos + TPP.PKG_HEADER_SIZE <= totalLen) {
        try {
            var type = dv.getUint8(pos);
            var size = dv.getUint32(pos + 1, TPP.LE);
            var timeMs = dv.getUint32(pos + 5, TPP.LE);
            var payloadOffset = pos + TPP.PKG_HEADER_SIZE;
            var validType = (type === TPP.TYPE_RDP_POINTER || type === TPP.TYPE_RDP_IMAGE || type === TPP.TYPE_RDP_KEYFRAME);
            var validSize = (payloadOffset + size <= totalLen) && (size < 50 * 1024 * 1024);
            if (!validType || !validSize) throw new Error('invalid packet');
            packets.push({ type: type, size: size, timeMs: timeMs, payloadOffset: payloadOffset, buffer: buffer });
            pos = payloadOffset + size;
        } catch (e) {
            var corruptStart = pos;
            var sizeField = pos + 5 <= totalLen ? dv.getUint32(pos + 1, TPP.LE) : 0;
            if (sizeField > 0 && sizeField < totalLen && pos + TPP.PKG_HEADER_SIZE + sizeField <= totalLen) {
                pos = pos + TPP.PKG_HEADER_SIZE + sizeField;
            } else {
                pos++;
                while (pos + TPP.PKG_HEADER_SIZE <= totalLen) {
                    var t = dv.getUint8(pos);
                    if (t === TPP.TYPE_RDP_POINTER || t === TPP.TYPE_RDP_IMAGE || t === TPP.TYPE_RDP_KEYFRAME) {
                        var s = dv.getUint32(pos + 1, TPP.LE);
                        if (s > 0 && s < 50 * 1024 * 1024 && pos + TPP.PKG_HEADER_SIZE + s <= totalLen) break;
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
};
