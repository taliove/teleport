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
            + '      <div id="loading-text">正在加载...</div>'
            + '      <div id="loading-progress"></div>'
            + '    </div>'
            + '    <div id="error-overlay" style="display:none">'
            + '      <div id="error-text"></div>'
            + '      <button id="error-retry">重试</button>'
            + '    </div>'
            + '  </div>'
            + '  <div id="control-bar">'
            + '    <button id="btn-play" class="ctrl-btn" title="播放/暂停 (Space)">&#9654;</button>'
            + '    <div id="progress-container">'
            + '      <div id="progress-bar">'
            + '        <div id="progress-played"></div>'
            + '        <div id="progress-handle"></div>'
            + '      </div>'
            + '    </div>'
            + '    <span id="time-display">00:00 / 00:00</span>'
            + '    <select id="speed-select">'
            + '      <option value="1">1x</option>'
            + '      <option value="2">2x</option>'
            + '      <option value="4">4x</option>'
            + '      <option value="8">8x</option>'
            + '      <option value="16">16x</option>'
            + '    </select>'
            + '    <label class="ctrl-label">'
            + '      <input type="checkbox" id="skip-silence" checked> 跳过静默'
            + '    </label>'
            + '    <span class="zoom-controls">'
            + '      <button id="btn-fit" class="ctrl-btn" title="适应窗口">适应</button>'
            + '      <button id="btn-original" class="ctrl-btn" title="原始大小">1:1</button>'
            + '      <button id="btn-zoom-in" class="ctrl-btn" title="放大">+</button>'
            + '      <button id="btn-zoom-out" class="ctrl-btn" title="缩小">-</button>'
            + '      <span id="zoom-display">100%</span>'
            + '    </span>'
            + '  </div>'
            + '</div>'
            + '<script>window.__TP_RID = "' + rid + '"; window.__TP_SERVER = location.origin;<\/script>';
    }
})();
