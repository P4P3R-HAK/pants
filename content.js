chrome.storage.sync.get(['enabled'], function (result) {
    if (result.enabled) {
        document.addEventListener('DOMContentLoaded', function () {
            const pageText = document.body.innerText || "(No text content available)";
            alert(pageText);

            if (pageText.toLowerCase().includes("phishing") || pageText.toLowerCase().includes("illegal")) {
                alert("This page might be suspicious. Please be careful!");
            }
        });
    }
});
