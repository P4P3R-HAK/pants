const statusMap = {
  blocked: { label: "차단됨", tone: "danger" },
  clean: { label: "정상", tone: "safe" },
  warning: { label: "주의", tone: "warning" },
  error: { label: "오프라인", tone: "muted" },
  disabled: { label: "비활성", tone: "muted" },
  trusted: { label: "신뢰됨", tone: "safe" },
  "session-allowed": { label: "임시 허용", tone: "warning" },
  pending: { label: "대기 중", tone: "muted" }
};

let currentTab = null;
let currentState = null;
let thresholdSaveTimer = null;
let latestThresholdRequestId = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const thresholdInput = document.getElementById("threshold");
  const thresholdValue = document.getElementById("threshold-value");
  const enabledToggle = document.getElementById("enabled-toggle");
  const currentHost = document.getElementById("current-host");
  const scanBadge = document.getElementById("scan-badge");
  const scanSummary = document.getElementById("scan-summary");
  const trustButton = document.getElementById("trust-button");
  const rescanButton = document.getElementById("rescan-button");
  const dashboardButton = document.getElementById("dashboard-button");
  const apiEndpoint = document.getElementById("api-endpoint");

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentState = await chrome.runtime.sendMessage({
    type: "getTabState",
    tabId: currentTab?.id,
    url: currentTab?.url
  });

  const settings = currentState.settings;
  thresholdInput.value = settings.threshold;
  updateThresholdDisplay(thresholdInput, thresholdValue, settings.threshold);
  enabledToggle.checked = settings.enabled;
  apiEndpoint.textContent = `${currentState.remoteProtection.display}. ${currentState.remoteProtection.detail}`;

  renderHost(currentHost, currentState.currentHost);
  renderScan(
    scanBadge,
    scanSummary,
    currentState.scan,
    settings.enabled,
    currentState.currentHost,
    currentState.trusted,
    currentState.sessionAllowed,
    settings.threshold
  );
  renderTrustButton(trustButton, currentState);
  renderRescanButton(rescanButton, currentTab, currentState);
  renderDashboardButton(dashboardButton, currentTab);

  thresholdInput.addEventListener("input", () => {
    const threshold = Number(thresholdInput.value);
    updateThresholdDisplay(thresholdInput, thresholdValue, threshold);
    currentState.settings.threshold = threshold;

    if (currentState.scan) {
      currentState.scan.threshold = threshold;
    }

    renderScan(
      scanBadge,
      scanSummary,
      currentState.scan,
      enabledToggle.checked,
      currentState.currentHost,
      currentState.trusted,
      currentState.sessionAllowed,
      threshold
    );
    queueThresholdSave(threshold);
  });

  thresholdInput.addEventListener("change", async () => {
    const requestId = createThresholdRequestId();
    await saveThreshold(Number(thresholdInput.value), thresholdInput, thresholdValue, scanBadge, scanSummary, enabledToggle, requestId);
  });

  enabledToggle.addEventListener("change", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "saveSettings",
      payload: { enabled: enabledToggle.checked }
    });

    currentState.settings = response.settings;
    renderScan(
      scanBadge,
      scanSummary,
      currentState.scan,
      response.settings.enabled,
      currentState.currentHost,
      currentState.trusted,
      currentState.sessionAllowed,
      currentState.settings.threshold
    );
  });

  trustButton.addEventListener("click", async () => {
    if (!currentState.currentHost) {
      return;
    }

    const shouldTrust = !currentState.trusted;
    const response = await chrome.runtime.sendMessage({
      type: "setTrustedDomain",
      hostname: currentState.currentHost,
      trusted: shouldTrust
    });

    if (!response.ok) {
      return;
    }

    currentState.trusted = shouldTrust;
    if (shouldTrust) {
      currentState.sessionAllowed = false;
    }
    renderTrustButton(trustButton, currentState);
    renderScan(
      scanBadge,
      scanSummary,
      currentState.scan,
      enabledToggle.checked,
      currentState.currentHost,
      currentState.trusted,
      currentState.sessionAllowed,
      currentState.settings.threshold
    );
  });

  rescanButton.addEventListener("click", async () => {
    if (!currentTab?.id) {
      return;
    }

    if (isSupportedTabUrl(currentTab.url)) {
      await chrome.tabs.reload(currentTab.id);
    } else if (currentState.scan?.url) {
      await chrome.tabs.update(currentTab.id, { url: currentState.scan.url });
    } else {
      return;
    }

    window.close();
  });

  dashboardButton.addEventListener("click", async () => {
    if (!chrome.sidePanel?.open || !currentTab?.windowId) {
      return;
    }

    await chrome.sidePanel.open({ windowId: currentTab.windowId });
    window.close();
  });
});

function updateThresholdDisplay(input, label, threshold) {
  const safeThreshold = Math.min(100, Math.max(0, Math.round(Number(threshold) || 0)));
  input.value = String(safeThreshold);
  label.textContent = `${safeThreshold}%`;
}

function queueThresholdSave(threshold) {
  if (thresholdSaveTimer !== null) {
    window.clearTimeout(thresholdSaveTimer);
  }

  const requestId = createThresholdRequestId();

  thresholdSaveTimer = window.setTimeout(() => {
    thresholdSaveTimer = null;
    saveThresholdSilently(threshold, requestId).catch((error) => {
      console.debug("차단 기준 저장 중 오류가 발생했습니다:", error);
    });
  }, 180);
}

function createThresholdRequestId() {
  latestThresholdRequestId += 1;
  return latestThresholdRequestId;
}

async function saveThresholdSilently(threshold, requestId) {
  const response = await chrome.runtime.sendMessage({
    type: "saveSettings",
    payload: { threshold }
  });

  if (!response.ok || requestId !== latestThresholdRequestId) {
    return;
  }

  currentState.settings = response.settings;

  if (currentState.scan) {
    currentState.scan.threshold = response.settings.threshold;
  }
}

async function saveThreshold(threshold, thresholdInput, thresholdValue, scanBadge, scanSummary, enabledToggle, requestId) {
  if (thresholdSaveTimer !== null) {
    window.clearTimeout(thresholdSaveTimer);
    thresholdSaveTimer = null;
  }

  const response = await chrome.runtime.sendMessage({
    type: "saveSettings",
    payload: { threshold }
  });

  if (!response.ok || requestId !== latestThresholdRequestId) {
    return;
  }

  currentState.settings = response.settings;

  if (currentState.scan) {
    currentState.scan.threshold = response.settings.threshold;
  }

  updateThresholdDisplay(thresholdInput, thresholdValue, response.settings.threshold);
  renderScan(
    scanBadge,
    scanSummary,
    currentState.scan,
    enabledToggle.checked,
    currentState.currentHost,
    currentState.trusted,
    currentState.sessionAllowed,
    response.settings.threshold
  );
}

function renderHost(element, host) {
  element.textContent = host || "지원되지 않는 페이지";
}

function renderScan(badge, summary, scan, enabled, host, trusted, sessionAllowed, threshold) {
  if (!host) {
    applyStatus(badge, "pending");
    summary.textContent = "검사는 http/https 페이지에서만 동작합니다.";
    return;
  }

  if (!enabled) {
    applyStatus(badge, "disabled");
    summary.textContent = "실시간 차단이 꺼져 있습니다.";
    return;
  }

  if (trusted) {
    applyStatus(badge, "trusted");
    summary.textContent = "현재 도메인은 신뢰 사이트 목록에 등록되어 있습니다.";
    return;
  }

  if (sessionAllowed) {
    applyStatus(badge, "session-allowed");
    summary.textContent = "현재 브라우저 세션 동안만 임시로 허용된 도메인입니다.";
    return;
  }

  if (!scan) {
    applyStatus(badge, "pending");
    summary.textContent = "아직 검사 결과가 없습니다. 페이지를 새로고침하면 다시 검사합니다.";
    return;
  }

  if (!["blocked", "session-allowed"].includes(scan.status) && scan.score >= threshold) {
    applyStatus(badge, "warning");
    summary.textContent = `현재 기준으로는 위험 점수 ${scan.score}%가 차단 기준 ${threshold}%를 넘습니다. 페이지를 새로고침하면 새 기준으로 다시 검사합니다.`;
    return;
  }

  applyStatus(badge, scan.status);

  switch (scan.status) {
    case "blocked":
      summary.textContent = `위험 점수 ${scan.score}%가 차단 기준 ${threshold}%를 넘어 페이지가 차단되었습니다.`;
      break;
    case "clean":
      summary.textContent = `최근 검사 결과는 정상이며 현재 위험 점수는 ${scan.score}%입니다.`;
      break;
    case "warning":
      summary.textContent = buildWarningText(scan, threshold);
      break;
    case "error":
      summary.textContent = "원격 분류기에 연결하지 못했고, 로컬 규칙만으로는 차단 기준에 도달하지 않았습니다.";
      break;
    case "session-allowed":
      summary.textContent = "현재 브라우저 세션 동안만 임시로 허용된 도메인입니다.";
      break;
    default:
      summary.textContent = "현재 검사 상태를 확인할 수 없습니다.";
      break;
  }
}

function buildWarningText(scan, threshold) {
  if (scan.remoteStatus === "private-target") {
    return `${scan.hostname || "현재 호스트"}는 사설망 또는 로컬 주소라서 로컬 규칙만으로 검사했습니다.`;
  }

  if (scan.remoteStatus === "disabled") {
    return `설정된 원격 분석 주소가 안전하지 않아 로컬 규칙만으로 검사했습니다. 현재 위험 점수는 ${scan.score}%입니다.`;
  }

  if (scan.remoteError) {
    return `원격 분류기에 접근하지 못했습니다. 로컬 규칙 기준 위험 점수는 ${scan.score}%입니다.`;
  }

  if (scan.score > 0) {
    return `의심 신호가 감지됐지만 위험 점수 ${scan.score}%가 차단 기준 ${threshold}%를 넘지는 않았습니다.`;
  }

  return "의심 신호가 감지되었습니다.";
}

function renderTrustButton(button, state) {
  if (!state.currentHost) {
    button.disabled = true;
    button.textContent = "지원되지 않는 페이지";
    return;
  }

  button.disabled = false;
  button.textContent = state.trusted ? "현재 사이트 신뢰 해제" : "현재 사이트 신뢰";
}

function renderDashboardButton(button, tab) {
  if (!chrome.sidePanel?.open || !tab?.windowId) {
    button.disabled = true;
    button.textContent = "대시보드 미지원";
    return;
  }

  button.disabled = false;
  button.textContent = "보안 대시보드";
}

function renderRescanButton(button, tab, state) {
  if (!tab?.id) {
    button.disabled = true;
    button.textContent = "재검사 불가";
    return;
  }

  button.disabled = false;
  button.textContent = isSupportedTabUrl(tab.url) || !state?.scan?.url
    ? "새로고침 후 재검사"
    : "원본 페이지 다시 열기";
}

function isSupportedTabUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function applyStatus(badge, status) {
  const descriptor = statusMap[status] || statusMap.pending;
  badge.className = `status-badge ${descriptor.tone}`;
  badge.textContent = descriptor.label;
}
