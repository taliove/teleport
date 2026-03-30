// Teleport RDP Web Player — Renderer
TPP.createRenderer = function(displayCanvas) {
    var displayCtx = displayCanvas.getContext('2d');
    var backbuffer = null, backCtx = null;
    var screenWidth = 0, screenHeight = 0;
    var cursorX = 0, cursorY = 0;
    var CURSOR_RADIUS = 5;

    function init(width, height) {
        screenWidth = width; screenHeight = height;
        displayCanvas.width = width; displayCanvas.height = height;
        backbuffer = new OffscreenCanvas(width, height);
        backCtx = backbuffer.getContext('2d');
        backCtx.fillStyle = '#263f6f';
        backCtx.fillRect(0, 0, width, height);
        flush();
    }
    function renderImageTile(rgba, destLeft, destTop, w, h) {
        if (!backCtx) return;
        backCtx.putImageData(new ImageData(rgba, w, h), destLeft, destTop);
    }
    function renderKeyframe(rgba, w, h) {
        if (!backCtx) return;
        backCtx.putImageData(new ImageData(rgba, w, h), 0, 0);
    }
    function updateCursor(x, y) { cursorX = x; cursorY = y; }
    function flush() {
        if (!backbuffer) return;
        displayCtx.drawImage(backbuffer, 0, 0);
        if (cursorX > 0 || cursorY > 0) {
            displayCtx.beginPath();
            displayCtx.arc(cursorX, cursorY, CURSOR_RADIUS, 0, 2 * Math.PI);
            displayCtx.fillStyle = 'rgba(255, 50, 50, 0.8)';
            displayCtx.fill();
            displayCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            displayCtx.lineWidth = 1;
            displayCtx.stroke();
        }
    }
    function clear() {
        if (backCtx) { backCtx.fillStyle = '#263f6f'; backCtx.fillRect(0, 0, screenWidth, screenHeight); }
        flush();
    }
    return {
        init: init, renderImageTile: renderImageTile, renderKeyframe: renderKeyframe,
        updateCursor: updateCursor, flush: flush, clear: clear,
        get width() { return screenWidth; }, get height() { return screenHeight; },
    };
};
