// Teleport RDP Web Player — Image Cache
TPP.createImageCache = function() {
    var entries = [];
    return {
        push: function (entry) { entries.push(entry); },
        get: function (index) { return (index >= 0 && index < entries.length) ? entries[index] : null; },
        clear: function () { entries = []; },
    };
};
