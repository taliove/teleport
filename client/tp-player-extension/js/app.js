// Teleport RDP Web Player — App Entry Point
(function() {
    'use strict';

    var TYPE_RDP_KEYFRAME = TPP.TYPE_RDP_KEYFRAME;

    var rid = window.__TP_RID || new URLSearchParams(location.search).get('rid');
    var serverBase = window.__TP_SERVER || location.origin;

    if (!rid) {
        showError('\u7f3a\u5c11\u53c2\u6570: rid (\u5f55\u5236ID)');
        return;
    }

    // --- DOM references ---
    var canvas = document.getElementById('player-canvas');
    var canvasWrapper = document.getElementById('canvas-wrapper');
    var canvasContainer = document.getElementById('canvas-container');
    var loadingOverlay = document.getElementById('loading-overlay');
    var loadingText = document.getElementById('loading-text');
    var loadingProgress = document.getElementById('loading-progress');
    var errorOverlay = document.getElementById('error-overlay');
    var errorText = document.getElementById('error-text');
    var metaInfo = document.getElementById('meta-info');
    var btnPlay = document.getElementById('btn-play');
    var speedGroup = document.getElementById('speed-group');
    var speedBtns = speedGroup.querySelectorAll('.seg-btn');
    var skipToggle = document.getElementById('skip-toggle');
    var skipGroup = document.getElementById('skip-group');
    var progressContainer = document.getElementById('progress-container');
    var progressPlayed = document.getElementById('progress-played');
    var progressHandle = document.getElementById('progress-handle');
    var progressBar = document.getElementById('progress-bar');
    var timeDisplay = document.getElementById('time-display');
    var btnFit = document.getElementById('btn-fit');
    var btnOriginal = document.getElementById('btn-original');
    var btnZoomIn = document.getElementById('btn-zoom-in');
    var btnZoomOut = document.getElementById('btn-zoom-out');
    var zoomDisplay = document.getElementById('zoom-display');
    var errorRetry = document.getElementById('error-retry');
    var toastContainer = document.getElementById('toast-container');

    // --- Core instances ---
    var downloader = TPP.createDownloader(serverBase, rid);
    var imageCache = TPP.createImageCache();
    var renderer = TPP.createRenderer(canvas);
    var zoom = TPP.createZoomController(canvasWrapper, canvasContainer, zoomDisplay);

    var player = TPP.createPlayer(renderer, imageCache, {
        onProgress: function (cur, total) { updateProgressBar(cur, total); },
        onEnd: function () { btnPlay.textContent = '\u25B6'; },
        onError: function (err) { console.error('Playback error:', err); },
    });

    // --- Preferences (localStorage) ---
    var PREFS_KEY = 'tp_player_prefs';
    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function savePrefs(update) {
        try {
            var prefs = Object.assign(loadPrefs(), update);
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (e) { /* quota or private mode */ }
    }

    // Apply saved preferences to UI
    var savedPrefs = loadPrefs();
    if (savedPrefs.speed) {
        for (var pi = 0; pi < speedBtns.length; pi++) {
            var isActive = parseInt(speedBtns[pi].getAttribute('data-speed'), 10) === savedPrefs.speed;
            speedBtns[pi].classList.toggle('active', isActive);
        }
        player.setSpeed(savedPrefs.speed);
    }
    if (savedPrefs.skipSilence !== undefined) {
        skipToggle.classList.toggle('active', savedPrefs.skipSilence);
        player.setSkipSilence(savedPrefs.skipSilence);
    }

    // --- Helpers ---
    function formatTime(ms) {
        var sec = Math.floor(ms / 1000);
        var m = Math.floor(sec / 60), s = sec % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updateProgressBar(cur, total) {
        var pct = total > 0 ? (cur / total) * 100 : 0;
        progressPlayed.style.width = pct + '%';
        progressHandle.style.left = pct + '%';
        timeDisplay.textContent = formatTime(cur) + ' / ' + formatTime(total);
    }

    function showError(msg) {
        loadingOverlay.style.display = 'none';
        errorOverlay.style.display = 'flex';
        errorText.textContent = msg;
    }

    function showLoading(text, progress) {
        loadingOverlay.style.display = 'flex';
        errorOverlay.style.display = 'none';
        loadingText.textContent = text;
        loadingProgress.textContent = progress || '';
    }

    function hideOverlays() {
        loadingOverlay.style.display = 'none';
        errorOverlay.style.display = 'none';
    }

    function showToast(msg, type) {
        var toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');
        toast.textContent = msg;
        toastContainer.appendChild(toast);
        setTimeout(function () {
            toast.classList.add('hiding');
            setTimeout(function () { toast.remove(); }, 300);
        }, 4000);
    }

    function renderCorruptMarks(corruptedRanges, pkts, total) {
        progressBar.querySelectorAll('.corrupt-mark').forEach(function (el) { el.remove(); });
        if (corruptedRanges.length === 0 || total <= 0) return;
        for (var r = 0; r < corruptedRanges.length; r++) {
            var range = corruptedRanges[r];
            var startMs = 0, endMs = total;
            for (var p = 0; p < pkts.length; p++) {
                if (pkts[p].payloadOffset <= range.startOffset) startMs = pkts[p].timeMs;
                if (pkts[p].payloadOffset >= range.endOffset) { endMs = pkts[p].timeMs; break; }
            }
            var mark = document.createElement('div');
            mark.className = 'corrupt-mark';
            mark.style.left = ((startMs / total) * 100) + '%';
            mark.style.width = Math.max(0.5, ((endMs - startMs) / total) * 100) + '%';
            mark.title = '\u635f\u574f\u533a\u57df: ' + formatTime(startMs) + ' - ' + formatTime(endMs);
            progressBar.appendChild(mark);
        }
    }

    // --- Speed control ---
    function setActiveSpeed(targetBtn) {
        for (var i = 0; i < speedBtns.length; i++) speedBtns[i].classList.remove('active');
        targetBtn.classList.add('active');
        player.setSpeed(parseInt(targetBtn.getAttribute('data-speed'), 10));
    }

    function cycleSpeed(dir) {
        var activeIdx = -1;
        for (var i = 0; i < speedBtns.length; i++) {
            if (speedBtns[i].classList.contains('active')) { activeIdx = i; break; }
        }
        var nextIdx = activeIdx + dir;
        if (nextIdx >= 0 && nextIdx < speedBtns.length) setActiveSpeed(speedBtns[nextIdx]);
    }

    // --- Zoom active-state tracking ---
    function updateZoomBtnState(mode) {
        btnFit.classList.toggle('active', mode === 'fit');
        btnOriginal.classList.toggle('active', mode === '1:1');
    }

    // --- Init & load ---
    function init() {
        showLoading('\u6b63\u5728\u52a0\u8f7d WASM \u6a21\u5757...');
        TPP.initDecoder().then(function () {
            showLoading('\u6b63\u5728\u4e0b\u8f7d\u5f55\u5236\u5934...');
            return downloader.readFile('tp-rdp.tpr');
        }).then(function (tprBuf) {
            if (!tprBuf) throw new Error('\u65e0\u6cd5\u4e0b\u8f7d tp-rdp.tpr');
            var header = TPP.parseHeader(tprBuf);
            metaInfo.textContent = 'RDP \u5f55\u5c4f\u56de\u653e \u2014 ' + header.accUsername + '@' + header.hostIp + ' (' + header.userUsername + ')';
            document.title = 'RDP \u56de\u653e \u2014 ' + header.accUsername + '@' + header.hostIp;
            renderer.init(header.width, header.height);
            zoom.init(header.width, header.height);

            // Apply saved zoom mode
            if (savedPrefs.zoomMode === '1:1') {
                zoom.originalSize();
                updateZoomBtnState('1:1');
            } else {
                updateZoomBtnState('fit');
            }

            showLoading('\u6b63\u5728\u4e0b\u8f7d\u5173\u952e\u5e27\u7d22\u5f15...');
            return downloader.readFile('tp-rdp.tpk').then(function (tpkBuf) {
                var keyframes = tpkBuf ? TPP.parseKeyframes(tpkBuf) : [];
                return { header: header, keyframes: keyframes };
            });
        }).then(function (ctx) {
            var header = ctx.header, keyframes = ctx.keyframes;
            var allPackets = [], corruptedRanges = [];

            if (header.datFileCount > 0) {
                showLoading('\u6b63\u5728\u4e0b\u8f7d\u6570\u636e\u6587\u4ef6 1/' + header.datFileCount + '...', '');
                return downloader.readFileWithProgress('tp-rdp-1.tpd', function (received, total) {
                    var pct = total > 0 ? Math.round(received / total * 100) : 0;
                    loadingProgress.textContent = pct + '% (' + (received / 1024 / 1024).toFixed(1) + ' MB)';
                }).then(function (firstBuf) {
                    if (firstBuf) {
                        var pkts = TPP.iteratePackets(firstBuf, corruptedRanges);
                        for (var i = 0; i < pkts.length; i++) allPackets.push(pkts[i]);
                    }
                    allPackets.sort(function (a, b) { return a.timeMs - b.timeMs; });
                    player.load(allPackets, keyframes, header.timeMs);
                    renderCorruptMarks(corruptedRanges, allPackets, header.timeMs);

                    // Seek to first keyframe to get a clean initial frame (avoids garbled tiles)
                    var firstKfTime = -1;
                    for (var fi = 0; fi < allPackets.length; fi++) {
                        if (allPackets[fi].type === TYPE_RDP_KEYFRAME) {
                            firstKfTime = allPackets[fi].timeMs;
                            break;
                        }
                    }
                    if (firstKfTime >= 0) {
                        player.seek(firstKfTime);
                    }

                    updateProgressBar(player.currentMs, header.timeMs);
                    hideOverlays();
                    player.play();
                    btnPlay.textContent = '\u23F8';

                    if (corruptedRanges.length > 0) {
                        showToast('\u68c0\u6d4b\u5230 ' + corruptedRanges.length + ' \u5904\u6570\u636e\u635f\u574f\uff0c\u5df2\u81ea\u52a8\u8df3\u8fc7', 'warning');
                    }

                    // Background-download remaining files (non-blocking)
                    var chain = Promise.resolve();
                    for (var f = 2; f <= header.datFileCount; f++) {
                        (function (idx) {
                            chain = chain.then(function () {
                                return downloader.readFileWithProgress('tp-rdp-' + idx + '.tpd', function () {}).then(function (buf) {
                                    if (!buf) {
                                        showToast('\u6570\u636e\u6587\u4ef6 ' + idx + ' \u4e0d\u5b58\u5728\uff0c\u5df2\u8df3\u8fc7', 'warning');
                                        return;
                                    }
                                    var pkts = TPP.iteratePackets(buf, corruptedRanges);
                                    for (var j = 0; j < pkts.length; j++) allPackets.push(pkts[j]);
                                    allPackets.sort(function (a, b) { return a.timeMs - b.timeMs; });
                                    player.updatePackets(allPackets, keyframes, header.timeMs);
                                    renderCorruptMarks(corruptedRanges, allPackets, header.timeMs);
                                }).catch(function (err) {
                                    showToast('\u6570\u636e\u6587\u4ef6 ' + idx + ' \u52a0\u8f7d\u5931\u8d25: ' + err.message, 'warning');
                                });
                            });
                        })(f);
                    }
                    return chain;
                });
            }
            hideOverlays();
        }).catch(function (err) {
            console.error('Init error:', err);
            if (err.code === 'AUTH_EXPIRED') showError('\u8ba4\u8bc1\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u540e\u518d\u8bd5');
            else showError('\u52a0\u8f7d\u5931\u8d25: ' + err.message);
        });
    }

    // --- UI event handlers ---

    // Play/Pause
    btnPlay.addEventListener('click', function () {
        btnPlay.textContent = player.togglePlayPause() ? '\u23F8' : '\u25B6';
    });

    // Segmented speed control
    for (var si = 0; si < speedBtns.length; si++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                setActiveSpeed(btn);
                savePrefs({ speed: parseInt(btn.getAttribute('data-speed'), 10) });
            });
        })(speedBtns[si]);
    }

    // Toggle switch — skip silence
    skipGroup.addEventListener('click', function () {
        skipToggle.classList.toggle('active');
        var isActive = skipToggle.classList.contains('active');
        player.setSkipSilence(isActive);
        savePrefs({ skipSilence: isActive });
    });

    // Progress bar seek
    var seeking = false, wasPlayingBeforeSeek = false;
    progressContainer.addEventListener('mousedown', function (e) {
        seeking = true;
        wasPlayingBeforeSeek = player.playing;
        player.pause();
        progressHandle.classList.add('active');
        seekToPosition(e);
    });
    window.addEventListener('mousemove', function (e) { if (seeking) seekToPosition(e); });
    window.addEventListener('mouseup', function () {
        if (seeking) {
            seeking = false;
            progressHandle.classList.remove('active');
            if (wasPlayingBeforeSeek) { player.play(); btnPlay.textContent = '\u23F8'; }
        }
    });
    function seekToPosition(e) {
        var rect = progressBar.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        player.seek(pct * player.totalMs);
    }

    // Zoom buttons
    btnFit.addEventListener('click', function () { zoom.fitToWindow(); updateZoomBtnState('fit'); savePrefs({ zoomMode: 'fit' }); });
    btnOriginal.addEventListener('click', function () { zoom.originalSize(); updateZoomBtnState('1:1'); savePrefs({ zoomMode: '1:1' }); });
    btnZoomIn.addEventListener('click', function () { zoom.zoomIn(); updateZoomBtnState(null); });
    btnZoomOut.addEventListener('click', function () { zoom.zoomOut(); updateZoomBtnState(null); });

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.code) {
            case 'Space':
                e.preventDefault(); btnPlay.click(); break;
            case 'ArrowLeft':
                e.preventDefault();
                var wl = player.playing;
                player.seek(Math.max(0, player.currentMs - 10000));
                if (wl) player.play();
                break;
            case 'ArrowRight':
                e.preventDefault();
                var wr = player.playing;
                player.seek(Math.min(player.totalMs, player.currentMs + 10000));
                if (wr) player.play();
                break;
            case 'Equal': case 'NumpadAdd':
                e.preventDefault(); cycleSpeed(1); break;
            case 'Minus': case 'NumpadSubtract':
                e.preventDefault(); cycleSpeed(-1); break;
        }
    });

    // Retry & resize
    errorRetry.addEventListener('click', function () { init(); });
    window.addEventListener('resize', function () { zoom.handleResize(); });

    init();
})();
