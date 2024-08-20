chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ threshold: 50, enabled: true }, () => {
    console.log("Extension installed: default threshold is 50% and enabled.");
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'checkUrlAndHtml') {
    const { url, html } = message;

    // 서버로 URL과 HTML을 함께 전송하여 불법 여부를 확인
    fetch('http://uskawjdu.iptime.org:8080/predict', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, html })
    })
    .then(response => response.json())
    .then(data => {
      const illegalPercent = data.illegalPercent;

      // 임계값 가져오기
      chrome.storage.sync.get(['threshold', 'enabled'], (result) => {
        const threshold = result.threshold;

        // 불법 여부가 임계값을 넘는지 확인
        if (result.enabled && illegalPercent >= threshold) {
          // URL이 임계값을 넘으면 차단된 페이지로 리디렉트
          const blockPageUrl = chrome.runtime.getURL("blocked.html") + `?originalUrl=${encodeURIComponent(url)}`;
          chrome.tabs.update(sender.tab.id, { url: blockPageUrl });
        }
      });
    })
    .catch(error => {
      console.error('Error checking URL and HTML:', error);
    });
  }
});
