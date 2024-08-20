document.addEventListener('DOMContentLoaded', function () {
    const toggleSwitch = document.getElementById('toggle-switch');
    const toggleLabel = document.getElementById('toggle-label');
    const reportButton = document.getElementById('report-button');

    // 저장된 설정 불러오기
    chrome.storage.sync.get(['enabled'], function (result) {
        const isEnabled = result.enabled || false;
        updateToggleState(isEnabled);
    });

    // 스위치 클릭 시 상태 변경
    toggleSwitch.addEventListener('click', function () {
        const isEnabled = !toggleSwitch.classList.contains('on');
        chrome.storage.sync.set({ enabled: isEnabled }, function () {
            console.log('Phishing detection is ' + (isEnabled ? 'enabled' : 'disabled'));
            updateToggleState(isEnabled);
        });

        // 확장 프로그램 상태에 따라 추가 처리
        chrome.runtime.sendMessage({ enabled: isEnabled });
    });

    // 신고 버튼 클릭 시 현재 페이지 URL을 신고
    reportButton.addEventListener('click', function () {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const currentUrl = tabs[0].url;

            if (currentUrl) {
                console.log('Reporting URL:', currentUrl);

                // 서버로 신고를 전송
                fetch('https://your-server-url.com/report', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url: currentUrl })
                })
                .then(response => response.json())
                .then(data => {
                    console.log('Report response:', data);
                    alert('Reported URL: ' + currentUrl);
                })
                .catch(error => {
                    console.error('Error reporting URL:', error);
                    alert('Failed to report URL.');
                });
            } else {
                console.error('No URL found.');
                alert('Failed to retrieve the current URL.');
            }
        });
    });

    function updateToggleState(isEnabled) {
        if (isEnabled) {
            toggleSwitch.classList.add('on');
            toggleLabel.textContent = 'Enabled';
        } else {
            toggleSwitch.classList.remove('on');
            toggleLabel.textContent = 'Disabled';
        }
    }
});
