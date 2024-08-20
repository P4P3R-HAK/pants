chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ enabled: true }, function () {
      console.log("Phishing Detector is enabled by default.");
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.enabled !== undefined) {
      if (message.enabled) {
          console.log("Phishing detection enabled.");
          // 여기에 기능을 활성화하는 로직을 추가
      } else {
          console.log("Phishing detection disabled.");
          // 여기에 기능을 비활성화하는 로직을 추가
      }
  }
});
