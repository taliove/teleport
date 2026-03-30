// Teleport RDP Web Player — Downloader
TPP.createDownloader = function(serverBase, rid) {
    function buildUrl(act, filename, extraParams) {
        var params = new URLSearchParams(
            Object.assign({ act: act, type: 'rdp', rid: String(rid), f: filename }, extraParams || {})
        );
        return serverBase + '/audit/get-file?' + params;
    }

    function fetchWithRetry(url, options, retries) {
        var retriesLeft = retries !== undefined ? retries : TPP.MAX_RETRIES;
        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TPP.FETCH_TIMEOUT_MS);
        return fetch(url, Object.assign({ credentials: 'include', signal: controller.signal }, options || {}))
            .then(function (resp) {
                clearTimeout(timeoutId);
                if (resp.status === 401 || resp.status === 403) {
                    throw Object.assign(new Error('\u8ba4\u8bc1\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55'), { code: 'AUTH_EXPIRED' });
                }
                if (resp.status === 416) return null;
                if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
                return resp;
            })
            .catch(function (err) {
                clearTimeout(timeoutId);
                if (err.code === 'AUTH_EXPIRED' || retriesLeft <= 0) throw err;
                if (err.name === 'AbortError' && retriesLeft <= 0) throw new Error('\u8bf7\u6c42\u8d85\u65f6');
                return new Promise(function (r) { setTimeout(r, TPP.RETRY_DELAY_MS); })
                    .then(function () { return fetchWithRetry(url, options, retriesLeft - 1); });
            });
    }

    function getFileSize(filename) {
        return fetchWithRetry(buildUrl('size', filename))
            .then(function (resp) { return resp.text(); })
            .then(function (text) {
                var size = parseInt(text, 10);
                if (isNaN(size) || size < 0) throw new Error('\u65e0\u6548\u7684\u6587\u4ef6\u5927\u5c0f: ' + text);
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
};
