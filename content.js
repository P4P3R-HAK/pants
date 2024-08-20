chrome.storage.sync.get(['enabled'], (result) => {
    if (result.enabled) {
      const currentUrl = window.location.href;
      const pageHtml = document.documentElement.outerHTML; // 페이지의 전체 HTML을 가져옴
  
      // 현재 URL과 HTML을 background 스크립트로 전송하여 검사를 요청
      chrome.runtime.sendMessage({ type: 'checkUrlAndHtml', url: currentUrl, html: pageHtml });
    }
  });
  
