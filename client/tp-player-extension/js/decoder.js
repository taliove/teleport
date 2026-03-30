// Teleport RDP Web Player — Decoder
(function() {
    var wasmReady = false;
    var wasmReadyPromise = null;

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

    TPP.initDecoder = function() {
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
    };

    TPP.decodeImageTile = function(imageInfo) {
        var data = imageInfo.data, width = imageInfo.width, height = imageInfo.height;
        var bitsPerPixel = imageInfo.bitsPerPixel, format = imageInfo.format;
        var zipLen = imageInfo.zipLen;

        if (format === TPP.RDP_IMG_RAW) {
            var pixelData = data;
            if (zipLen > 0) pixelData = zlibDecompress(data);
            var rgba = bitsPerPixel === 15 ? rgb555ToRgba(pixelData, width, height) : rgb565ToRgba(pixelData, width, height);
            flipVertical(rgba, width, height);
            return { rgba: rgba, width: width, height: height };
        }
        if (format === TPP.RDP_IMG_BMP) {
            var rleData = data;
            if (zipLen > 0) rleData = zlibDecompress(data);
            var rgba2 = rleDecompress(new Uint8Array(rleData), width, height, bitsPerPixel);
            return { rgba: rgba2, width: width, height: height };
        }
        return null;
    };

    TPP.decodeKeyframe = function(data, width, height) {
        var expectedSize = width * height * 2;
        var pixelData = data;
        if (data.byteLength !== expectedSize) pixelData = zlibDecompress(data);
        if (pixelData.byteLength < expectedSize) {
            throw new Error('Keyframe data too short: got ' + pixelData.byteLength + ', expected ' + expectedSize);
        }
        return rgb565ToRgba(new Uint8Array(pixelData), width, height);
    };
})();
