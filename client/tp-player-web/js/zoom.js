// Zoom & Pan — CSS transform-based scaling on #canvas-wrapper
// Reference: spec Zoom & Pan section
//
// - Cmd+scroll (macOS) / Ctrl+scroll (Windows): zoom 25% steps, range 25%-400%
// - Buttons: Fit Window, 1:1, +, -
// - Click-drag to pan when zoomed in

export function createZoomController(canvasWrapper, canvasContainer, displayEl) {
    let scale = 1.0;
    let panX = 0;
    let panY = 0;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let fitMode = true; // track whether user is in auto-fit mode

    const MIN_SCALE = 0.25;
    const MAX_SCALE = 4.0;
    const STEP = 0.25;

    // Drag state
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let panStartX = 0;
    let panStartY = 0;

    function init(width, height) {
        canvasWidth = width;
        canvasHeight = height;
        fitToWindow();
    }

    function setScale(newScale) {
        fitMode = false;
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        applyTransform();
        updateDisplay();
    }

    function fitToWindow() {
        fitMode = true;
        const containerRect = canvasContainer.getBoundingClientRect();
        const scaleX = containerRect.width / canvasWidth;
        const scaleY = containerRect.height / canvasHeight;
        scale = Math.min(scaleX, scaleY, 1.0); // don't upscale beyond 1:1
        panX = 0;
        panY = 0;
        applyTransform();
        updateDisplay();
    }

    function originalSize() {
        fitMode = false;
        scale = 1.0;
        panX = 0;
        panY = 0;
        applyTransform();
        updateDisplay();
    }

    function zoomIn() { setScale(scale + STEP); }
    function zoomOut() { setScale(scale - STEP); }

    function applyTransform() {
        // Center the canvas in the container
        const containerRect = canvasContainer.getBoundingClientRect();
        const scaledW = canvasWidth * scale;
        const scaledH = canvasHeight * scale;
        const offsetX = Math.max(0, (containerRect.width - scaledW) / 2);
        const offsetY = Math.max(0, (containerRect.height - scaledH) / 2);

        canvasWrapper.style.transform = `translate(${offsetX + panX}px, ${offsetY + panY}px) scale(${scale})`;
    }

    function updateDisplay() {
        if (displayEl) displayEl.textContent = `${Math.round(scale * 100)}%`;
    }

    // Scroll wheel zoom
    function handleWheel(e) {
        if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -STEP : STEP;
            setScale(scale + delta);
        }
    }

    // Drag to pan
    function handleMouseDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = panX;
        panStartY = panY;
        canvasWrapper.classList.add('dragging');
    }

    function handleMouseMove(e) {
        if (!dragging) return;
        panX = panStartX + (e.clientX - dragStartX);
        panY = panStartY + (e.clientY - dragStartY);
        applyTransform();
    }

    function handleMouseUp() {
        if (!dragging) return;
        dragging = false;
        canvasWrapper.classList.remove('dragging');
    }

    // Attach event listeners
    canvasContainer.addEventListener('wheel', handleWheel, { passive: false });
    canvasWrapper.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return { init, fitToWindow, originalSize, zoomIn, zoomOut, get scale() { return scale; }, get isFitMode() { return fitMode; }, handleResize() { if (fitMode) fitToWindow(); else applyTransform(); } };
}
