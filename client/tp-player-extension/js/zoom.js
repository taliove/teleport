// Teleport RDP Web Player — Zoom & Pan
TPP.createZoomController = function(canvasWrapper, canvasContainer, displayEl) {
    var scale = 1.0, panX = 0, panY = 0, canvasWidth = 0, canvasHeight = 0, fitMode = true;
    var MIN_SCALE = 0.25, MAX_SCALE = 4.0, STEP = 0.25;
    var dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;

    function init(w, h) { canvasWidth = w; canvasHeight = h; fitToWindow(); }
    function setScale(s) { fitMode = false; scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); applyTransform(); updateDisplay(); }
    function fitToWindow() {
        fitMode = true;
        var r = canvasContainer.getBoundingClientRect();
        scale = Math.min(r.width / canvasWidth, r.height / canvasHeight);
        panX = 0; panY = 0; applyTransform(); updateDisplay();
    }
    function originalSize() { fitMode = false; scale = 1.0; panX = 0; panY = 0; applyTransform(); updateDisplay(); }
    function zoomIn() { setScale(scale + STEP); }
    function zoomOut() { setScale(scale - STEP); }
    function applyTransform() {
        var r = canvasContainer.getBoundingClientRect();
        var ox = Math.max(0, (r.width - canvasWidth * scale) / 2);
        var oy = Math.max(0, (r.height - canvasHeight * scale) / 2);
        canvasWrapper.style.transform = 'translate(' + (ox + panX) + 'px, ' + (oy + panY) + 'px) scale(' + scale + ')';
    }
    function updateDisplay() { if (displayEl) displayEl.textContent = Math.round(scale * 100) + '%'; }
    function handleResize() { if (fitMode) fitToWindow(); else applyTransform(); }

    canvasContainer.addEventListener('wheel', function (e) {
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); setScale(scale + (e.deltaY > 0 ? -STEP : STEP)); }
    }, { passive: false });
    canvasWrapper.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        dragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
        panStartX = panX; panStartY = panY; canvasWrapper.classList.add('dragging');
    });
    window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        panX = panStartX + (e.clientX - dragStartX); panY = panStartY + (e.clientY - dragStartY);
        applyTransform();
    });
    window.addEventListener('mouseup', function () {
        if (!dragging) return; dragging = false; canvasWrapper.classList.remove('dragging');
    });

    return { init: init, fitToWindow: fitToWindow, originalSize: originalSize, zoomIn: zoomIn, zoomOut: zoomOut, handleResize: handleResize };
};
