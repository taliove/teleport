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
