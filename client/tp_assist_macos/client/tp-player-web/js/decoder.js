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
