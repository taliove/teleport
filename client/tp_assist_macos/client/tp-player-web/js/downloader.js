// Downloader — fetch binary files from Teleport's /audit/get-file API
//
// API contract:
//   GET /audit/get-file?act=size&type=rdp&rid={rid}&f={filename}  → file size as text
//   GET /audit/get-file?act=read&type=rdp&rid={rid}&f={filename}  → binary content
// Authentication: _sid cookie sent automatically (same-origin, credentials: 'include')

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 30000;

export function createDownloader(serverBase, rid) {
    function buildUrl(act, filename, extraParams) {
        const params = new URLSearchParams({
            act,
            type: 'rdp',
            rid: String(rid),
            f: filename,
            ...extraParams,
        });
        return `${serverBase}/audit/get-file?${params}`;
    }

    async function fetchWithRetry(url, options, retries) {
        const retriesLeft = retries ?? MAX_RETRIES;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(url, {
                credentials: 'include',
                signal: controller.signal,
                ...options,
            });
            clearTimeout(timeoutId);
            if (resp.status === 401 || resp.status === 403) {
                throw Object.assign(new Error('认证已过期，请重新登录'), { code: 'AUTH_EXPIRED' });
            }
            if (resp.status === 416) {
                return null; // offset out of range = end of file
            }
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }
            return resp;
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.code === 'AUTH_EXPIRED' || retriesLeft <= 0) throw err;
            if (err.name === 'AbortError') {
                if (retriesLeft <= 0) throw new Error('请求超时');
            }
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            return fetchWithRetry(url, options, retriesLeft - 1);
        }
    }

    async function getFileSize(filename) {
        const url = buildUrl('size', filename);
        const resp = await fetchWithRetry(url);
        const text = await resp.text();
        const size = parseInt(text, 10);
        if (isNaN(size) || size < 0) {
            throw new Error(`无效的文件大小: ${text}`);
        }
        return size;
    }

    async function readFile(filename) {
        const url = buildUrl('read', filename);
        const resp = await fetchWithRetry(url);
        if (!resp) return null;
        const buf = await resp.arrayBuffer();
        return buf;
    }

    async function readFileWithProgress(filename, onProgress) {
        const size = await getFileSize(filename);
        const url = buildUrl('read', filename);
        const resp = await fetchWithRetry(url);
        if (!resp) return null;

        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            if (onProgress) onProgress(received, size);
        }

        const result = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result.buffer;
    }

    return { getFileSize, readFile, readFileWithProgress, buildUrl };
}
