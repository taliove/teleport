// Content script for /audit/replay/* pages
// When ?tp_web_player=1 is in the URL, replaces the original page with our web player.
//
// How it works:
//   1. Runs at document_start (before original page loads)
//   2. Replaces the entire document with our player HTML
//   3. Injects pako.min.js, rle.js, player-bundle.js from extension resources
//   4. Scripts run in the page's main world → fetch() is same-origin → cookies included
//
// This avoids all CORS/cookie issues because the page URL stays on the Teleport server.

(function () {
    'use strict';

    var params = new URLSearchParams(location.search);
    if (!params.has('tp_web_player')) return; // not our page — let original replay work

    var rid = params.get('rid') || location.pathname.split('/').pop();
    var extBase = chrome.runtime.getURL('');

    // Replace the entire document at document_start (before original page loads)
    document.addEventListener('DOMContentLoaded', function () {
        takeover();
    });

    // Also try immediately in case DOMContentLoaded already fired
    if (document.readyState !== 'loading') {
        takeover();
    }

    var taken = false;
    function takeover() {
        if (taken) return;
        taken = true;

        // Clear the page
        document.head.innerHTML = '';
        document.body.innerHTML = '';

        // -- Head --
        appendMeta('charset', 'UTF-8');
        appendMeta('name', 'viewport', 'width=device-width, initial-scale=1.0');
        appendLink(extBase + 'css/player.css');
        document.title = 'RDP 录屏回放';

        // -- Body (player HTML) --
        document.body.innerHTML = getPlayerHTML();

        // -- Scripts (load in order: pako → rle → bundle) --
        loadScript(extBase + 'lib/pako.min.js', function () {
            loadScript(extBase + 'lib/rle.js', function () {
                loadScript(extBase + 'js/player-bundle.js');
            });
        });
    }

    function appendMeta(attr, name, content) {
        var meta = document.createElement('meta');
        if (attr === 'charset') { meta.setAttribute('charset', name); }
        else { meta.name = name; meta.content = content; }
        document.head.appendChild(meta);
    }

    function appendLink(href) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }

    function loadScript(src, onload) {
        var script = document.createElement('script');
        script.src = src;
        if (onload) script.onload = onload;
        document.body.appendChild(script);
    }

    function getPlayerHTML() {
        return ''
            + '<div id="player-app">'
            + '  <div id="top-bar">'
            + '    <span id="meta-info">RDP 录屏回放</span>'
            + '  </div>'
            + '  <div id="canvas-container">'
            + '    <div id="canvas-wrapper">'
            + '      <canvas id="player-canvas"></canvas>'
            + '    </div>'
            + '    <div id="loading-overlay">'
            + '      <div class="spinner"></div>'
            + '      <div id="loading-text">正在加载...</div>'
            + '      <div id="loading-progress"></div>'
            + '    </div>'
            + '    <div id="error-overlay" style="display:none">'
            + '      <div id="error-icon">&#9888;</div>'
            + '      <div id="error-text"></div>'
            + '      <button id="error-retry">重试</button>'
            + '    </div>'
            + '  </div>'
            + '  <div id="control-bar">'
            + '    <div id="controls-row-1">'
            + '      <button id="btn-play" title="播放/暂停 (Space)">&#9654;</button>'
            + '      <div id="progress-container">'
            + '        <div id="progress-bar">'
            + '          <div id="progress-played"></div>'
            + '          <div id="progress-handle"></div>'
            + '        </div>'
            + '      </div>'
            + '      <span id="time-display">00:00 / 00:00</span>'
            + '    </div>'
            + '    <div id="controls-row-2">'
            + '      <div id="speed-group" class="segmented-control">'
            + '        <button class="seg-btn active" data-speed="1">1x</button>'
            + '        <button class="seg-btn" data-speed="2">2x</button>'
            + '        <button class="seg-btn" data-speed="4">4x</button>'
            + '        <button class="seg-btn" data-speed="8">8x</button>'
            + '        <button class="seg-btn" data-speed="16">16x</button>'
            + '      </div>'
            + '      <div class="ctrl-separator"></div>'
            + '      <div class="toggle-group" id="skip-group">'
            + '        <div id="skip-toggle" class="toggle active"><div class="toggle-knob"></div></div>'
            + '        <span>跳过静默</span>'
            + '      </div>'
            + '      <div class="ctrl-separator"></div>'
            + '      <div class="zoom-controls">'
            + '        <button id="btn-zoom-out" class="icon-btn" title="缩小">&#8722;</button>'
            + '        <span id="zoom-display">100%</span>'
            + '        <button id="btn-zoom-in" class="icon-btn" title="放大">+</button>'
            + '        <div class="ctrl-separator"></div>'
            + '        <button id="btn-fit" class="text-btn active" title="适应窗口">适应</button>'
            + '        <button id="btn-original" class="text-btn" title="原始大小">1:1</button>'
            + '      </div>'
            + '    </div>'
            + '  </div>'
            + '  <div id="toast-container"></div>'
            + '</div>'
            + '<script>window.__TP_RID = "' + rid + '"; window.__TP_SERVER = location.origin;<\/script>';
    }
})();
