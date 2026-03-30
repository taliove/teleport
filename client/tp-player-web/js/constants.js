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
