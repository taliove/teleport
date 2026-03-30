// Renderer — off-screen canvas backbuffer + cursor overlay
// Reference: client/tp-player/mainwindow.cpp _do_update_data()
//
// - Maintains an off-screen canvas (backbuffer) at recording resolution
// - Renders decoded image tiles via putImageData
// - Draws cursor position as a red dot
// - Copies backbuffer to visible canvas via drawImage

export function createRenderer(displayCanvas) {
    const displayCtx = displayCanvas.getContext('2d');

    // Off-screen backbuffer — created when header is received
    let backbuffer = null;
    let backCtx = null;
    let screenWidth = 0;
    let screenHeight = 0;

    // Cursor state
    let cursorX = 0;
    let cursorY = 0;
    const CURSOR_RADIUS = 5;

    function init(width, height) {
        screenWidth = width;
        screenHeight = height;

        // Set display canvas size to match recording
        displayCanvas.width = width;
        displayCanvas.height = height;

        // Create off-screen backbuffer
        backbuffer = new OffscreenCanvas(width, height);
        backCtx = backbuffer.getContext('2d');

        // Fill with dark blue background (same as Qt player: #263f6f)
        backCtx.fillStyle = '#263f6f';
        backCtx.fillRect(0, 0, width, height);

        flush();
    }

    function renderImageTile(rgba, destLeft, destTop, width, height) {
        if (!backCtx) return;
        const imageData = new ImageData(rgba, width, height);
        backCtx.putImageData(imageData, destLeft, destTop);
    }

    function renderKeyframe(rgba, width, height) {
        if (!backCtx) return;
        const imageData = new ImageData(rgba, width, height);
        backCtx.putImageData(imageData, 0, 0);
    }

    function updateCursor(x, y) {
        cursorX = x;
        cursorY = y;
    }

    // Copy backbuffer to display canvas + draw cursor
    function flush() {
        if (!backbuffer) return;
        displayCtx.drawImage(backbuffer, 0, 0);

        // Draw cursor as red dot
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
        if (backCtx) {
            backCtx.fillStyle = '#263f6f';
            backCtx.fillRect(0, 0, screenWidth, screenHeight);
        }
        flush();
    }

    return {
        init,
        renderImageTile,
        renderKeyframe,
        updateCursor,
        flush,
        clear,
        get width() { return screenWidth; },
        get height() { return screenHeight; },
    };
}
