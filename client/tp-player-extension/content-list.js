// Content script for /audit/record* pages (Teleport audit record list)
// Adds a "浏览器播放" button next to each RDP "回放" button.
// The button opens the server's own /audit/replay page with ?tp_web_player=1,
// which triggers content-player.js to take over and load our web player.

(function () {
    'use strict';

    function addWebPlayButtons() {
        const buttons = document.querySelectorAll('a[data-action="replay"]');
        buttons.forEach(function (btn) {
            if (btn.nextElementSibling && btn.nextElementSibling.classList.contains('tp-web-play')) {
                return; // already added
            }
            const rid = btn.getAttribute('data-record-id');
            if (!rid) return;

            const webBtn = document.createElement('a');
            webBtn.href = 'javascript:;';
            webBtn.className = 'btn btn-sm btn-success tp-web-play';
            webBtn.style.marginLeft = '4px';
            webBtn.innerHTML = '<i class="fa fa-play-circle fa-fw"></i> 浏览器播放';
            webBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                window.open(
                    '/audit/replay/1/' + rid + '?tp_web_player=1&rid=' + rid,
                    '_blank'
                );
            });
            btn.parentElement.insertBefore(webBtn, btn.nextSibling);
        });
    }

    // Initial run (table may already be rendered)
    addWebPlayButtons();

    // Watch for dynamically added rows (DataTables renders async)
    var tableEl = document.getElementById('table-record');
    if (tableEl) {
        new MutationObserver(addWebPlayButtons).observe(tableEl, { childList: true, subtree: true });
    } else {
        // Table might not exist yet — observe body until it appears
        var bodyObs = new MutationObserver(function () {
            var t = document.getElementById('table-record');
            if (t) {
                bodyObs.disconnect();
                addWebPlayButtons();
                new MutationObserver(addWebPlayButtons).observe(t, { childList: true, subtree: true });
            }
        });
        bodyObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
})();
