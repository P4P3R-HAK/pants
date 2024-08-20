document.addEventListener('DOMContentLoaded', () => {
    const thresholdInput = document.getElementById('threshold');
    const toggleSwitch = document.getElementById('toggle-switch');
    const toggleLabel = document.getElementById('toggle-label');
  
    // 저장된 설정 불러오기
    chrome.storage.sync.get(['threshold', 'enabled'], (result) => {
      thresholdInput.value = result.threshold || 50;
      updateToggleState(result.enabled);
    });
  
    // 임계값 변경 시 저장
    thresholdInput.addEventListener('input', () => {
      const threshold = parseInt(thresholdInput.value);
      chrome.storage.sync.set({ threshold }, () => {
        console.log('Threshold updated to:', threshold);
      });
    });
  
    // 스위치 클릭 시 상태 변경
    toggleSwitch.addEventListener('click', () => {
      const isEnabled = !toggleSwitch.classList.contains('on');
      chrome.storage.sync.set({ enabled: isEnabled }, () => {
        console.log('Phishing detection is ' + (isEnabled ? 'enabled' : 'disabled'));
        updateToggleState(isEnabled);
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
  
