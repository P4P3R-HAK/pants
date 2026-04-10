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

const statDescriptors = [
  { key: "totalScans", label: "총 검사" },
  { key: "blockedCount", label: "차단" },
  { key: "riskCount", label: "주의/차단" },
  { key: "trustedCount", label: "신뢰 사이트" },
  { key: "sessionCount", label: "세션 허용" }
];

let currentTab = null;
let currentState = null;
let refreshTimer = null;

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    heroDetail: document.getElementById("hero-detail"),
    reloadTab: document.getElementById("reload-tab"),
    refreshDashboard: document.getElementById("refresh-dashboard"),
    currentHost: document.getElementById("current-host"),
    currentStatus: document.getElementById("current-status"),
    currentSummary: document.getElementById("current-summary"),
    currentScore: document.getElementById("current-score"),
    currentThreshold: document.getElementById("current-threshold"),
    scoreFill: document.getElementById("score-fill"),
    toggleTrust: document.getElementById("toggle-trust"),
    toggleSession: document.getElementById("toggle-session"),
    reasonList: document.getElementById("reason-list"),
    statsGrid: document.getElementById("stats-grid"),
    remoteMode: document.getElementById("remote-mode"),
    remoteDetail: document.getElementById("remote-detail"),
    historyList: document.getElementById("history-list"),
    clearHistory: document.getElementById("clear-history"),
    trustedCount: document.getElementById("trusted-count"),
    trustedList: document.getElementById("trusted-list"),
    clearSession: document.getElementById("clear-session"),
    sessionList: document.getElementById("session-list")
  };

  elements.refreshDashboard.addEventListener("click", async () => {
    await refreshDashboard(elements);
  });

  elements.reloadTab.addEventListener("click", async () => {
    if (!currentTab?.id) {
      return;
    }

    if (isSupportedTabUrl(currentTab.url)) {
      await chrome.tabs.reload(currentTab.id);
      return;
    }

    if (currentState?.scan?.url) {
      await chrome.tabs.update(currentTab.id, { url: currentState.scan.url });
    }
  });

  elements.toggleTrust.addEventListener("click", async () => {
    if (!currentState?.currentHost) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "setTrustedDomain",
      hostname: currentState.currentHost,
      trusted: !currentState.trusted
    });

    if (response.ok) {
      await refreshDashboard(elements);
    }
  });

  elements.toggleSession.addEventListener("click", async () => {
    if (!currentState?.currentHost || currentState.trusted) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "setSessionAllowance",
      hostname: currentState.currentHost,
      allowed: !currentState.sessionAllowed
    });

    if (response.ok) {
      await refreshDashboard(elements);
    }
  });

  elements.clearHistory.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "clearScanHistory"
    });

    if (response.ok) {
      await refreshDashboard(elements);
    }
  });

  elements.clearSession.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "clearSessionAllowlist"
    });

    if (response.ok) {
      await refreshDashboard(elements);
    }
  });

  elements.trustedList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-host]");

    if (!button) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "setTrustedDomain",
      hostname: button.dataset.host,
      trusted: false
    });

    if (response.ok) {
      await refreshDashboard(elements);
    }
  });

  elements.sessionList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-host]");

    if (!button) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "setSessionAllowance",
      hostname: button.dataset.host,
      allowed: false
    });

    if (response.ok) {
      await refreshDashboard(elements);
    }
  });

  chrome.storage.onChanged.addListener(() => {
    scheduleRefresh(elements);
  });

  chrome.tabs.onActivated.addListener(() => {
    scheduleRefresh(elements);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active) {
      return;
    }

    if (changeInfo.status === "complete" || changeInfo.url) {
      scheduleRefresh(elements);
    }
  });

  await refreshDashboard(elements);
});

function scheduleRefresh(elements) {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
  }

  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    refreshDashboard(elements).catch((error) => {
      console.debug("대시보드 갱신을 건너뛰었습니다:", error);
    });
  }, 160);
}

async function refreshDashboard(elements) {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentState = await chrome.runtime.sendMessage({
    type: "getDashboardState",
    tabId: currentTab?.id,
    url: currentTab?.url
  });

  renderDashboard(elements, currentState);
}

function renderDashboard(elements, state) {
  renderCurrentStatus(elements, state);
  renderStats(elements.statsGrid, state.stats);
  renderRemoteProtection(elements, state.remoteProtection);
  renderHistory(elements.historyList, state.recentHistory);
  renderDomainList(elements.trustedList, state.trustedDomains, "해제", "등록된 신뢰 사이트가 없습니다.");
  renderDomainList(elements.sessionList, state.sessionAllowlist, "삭제", "임시 허용된 사이트가 없습니다.");
  renderReloadButton(elements.reloadTab, currentTab, state);

  elements.trustedCount.textContent = `${state.trustedDomains.length}개`;
  elements.heroDetail.textContent = buildHeroDetail(state);
}

function renderCurrentStatus(elements, state) {
  const threshold = clampPercentage(state.settings?.threshold ?? 0);
  const score = clampPercentage(state.scan?.score ?? 0);
  const host = state.currentHost || "지원되지 않는 페이지";

  elements.currentHost.textContent = host;
  elements.currentSummary.textContent = buildSummary(state, threshold);
  elements.currentScore.textContent = `${score}%`;
  elements.currentThreshold.textContent = `차단 기준 ${threshold}%`;
  elements.scoreFill.style.width = `${score}%`;

  applyStatus(elements.currentStatus, getDisplayStatus(state));
  renderReasons(elements.reasonList, state.scan?.reasons);
  renderCurrentActions(elements, state);
}

function renderCurrentActions(elements, state) {
  if (!state.currentHost) {
    elements.toggleTrust.disabled = true;
    elements.toggleTrust.textContent = "지원되지 않는 페이지";
    elements.toggleSession.disabled = true;
    elements.toggleSession.textContent = "세션 허용";
    return;
  }

  elements.toggleTrust.disabled = false;
  elements.toggleTrust.textContent = state.trusted ? "현재 사이트 신뢰 해제" : "현재 사이트 신뢰";

  if (state.trusted) {
    elements.toggleSession.disabled = true;
    elements.toggleSession.textContent = "신뢰 사이트 적용 중";
    return;
  }

  elements.toggleSession.disabled = false;
  elements.toggleSession.textContent = state.sessionAllowed ? "세션 허용 해제" : "이번 세션 허용";
}

function renderReasons(container, reasons) {
  container.textContent = "";

  const items = Array.isArray(reasons) && reasons.length > 0
    ? reasons
    : ["탐지 근거가 없거나 최근 검사 결과가 아직 없습니다."];

  for (const reason of items) {
    const li = document.createElement("li");
    li.textContent = reason;
    container.appendChild(li);
  }
}

function renderStats(container, stats) {
  container.textContent = "";

  for (const descriptor of statDescriptors) {
    const card = document.createElement("article");
    card.className = "stat-card";

    const label = document.createElement("p");
    label.className = "section-label";
    label.textContent = descriptor.label;

    const value = document.createElement("strong");
    value.textContent = String(stats?.[descriptor.key] ?? 0);

    card.append(label, value);
    container.appendChild(card);
  }
}

function renderRemoteProtection(elements, remoteProtection) {
  elements.remoteMode.textContent = remoteProtection.mode === "remote"
    ? "원격 분류기 + 로컬 규칙"
    : "로컬 규칙만 사용";
  elements.remoteDetail.textContent = `${remoteProtection.display}. ${remoteProtection.detail}`;
}

function renderHistory(container, historyItems) {
  container.textContent = "";

  if (!Array.isArray(historyItems) || historyItems.length === 0) {
    container.appendChild(createEmptyState("아직 누적된 검사 기록이 없습니다."));
    return;
  }

  for (const item of historyItems) {
    const li = document.createElement("li");
    li.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";

    const title = document.createElement("p");
    title.className = "history-title";
    title.textContent = item.pageTitle || item.hostname || "기록 없음";

    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = buildHistoryMeta(item);

    main.append(title, meta);

    const score = document.createElement("div");
    score.className = "history-score";
    score.textContent = item.status === "blocked" || item.status === "warning"
      ? `${clampPercentage(item.score)}%`
      : (statusMap[item.status]?.label || "기록");

    li.append(main, score);
    container.appendChild(li);
  }
}

function renderDomainList(container, domains, buttonLabel, emptyText) {
  container.textContent = "";

  if (!Array.isArray(domains) || domains.length === 0) {
    container.appendChild(createEmptyState(emptyText));
    return;
  }

  for (const host of domains) {
    const li = document.createElement("li");
    li.className = "domain-item";

    const main = document.createElement("div");
    main.className = "domain-main";

    const title = document.createElement("p");
    title.className = "domain-title";
    title.textContent = host;

    const sub = document.createElement("p");
    sub.className = "domain-sub";
    sub.textContent = buttonLabel === "해제"
      ? "이 사이트는 차단 대상에서 항상 제외됩니다."
      : "브라우저를 종료하면 자동으로 초기화됩니다.";

    const button = document.createElement("button");
    button.className = "domain-remove";
    button.type = "button";
    button.dataset.host = host;
    button.textContent = buttonLabel;

    main.append(title, sub);
    li.append(main, button);
    container.appendChild(li);
  }
}

function createEmptyState(text) {
  const li = document.createElement("li");
  li.className = "empty-state";
  li.textContent = text;
  return li;
}

function applyStatus(element, status) {
  const descriptor = statusMap[status] || statusMap.pending;
  element.className = `status-pill ${descriptor.tone}`;
  element.textContent = descriptor.label;
}

function getDisplayStatus(state) {
  if (!state.currentHost) {
    return "pending";
  }

  if (!state.settings.enabled) {
    return "disabled";
  }

  if (state.trusted) {
    return "trusted";
  }

  if (state.sessionAllowed) {
    return "session-allowed";
  }

  return state.scan?.status || "pending";
}

function buildSummary(state, threshold) {
  if (!state.currentHost) {
    return "검사는 http/https 페이지에서만 동작합니다.";
  }

  if (!state.settings.enabled) {
    return "실시간 차단이 꺼져 있습니다.";
  }

  if (state.trusted) {
    return "현재 도메인은 신뢰 사이트 목록에 등록되어 있습니다.";
  }

  if (state.sessionAllowed) {
    return "현재 브라우저 세션 동안만 임시 허용된 도메인입니다.";
  }

  if (!state.scan) {
    return "아직 검사 결과가 없습니다. 페이지를 새로고침하면 다시 검사합니다.";
  }

  if (!["blocked", "session-allowed"].includes(state.scan.status) && state.scan.score >= threshold) {
    return `현재 기준으로는 위험 점수 ${state.scan.score}%가 차단 기준 ${threshold}%를 넘습니다. 새로고침하면 새 기준으로 다시 검사합니다.`;
  }

  switch (state.scan.status) {
    case "blocked":
      return `위험 점수 ${state.scan.score}%가 차단 기준 ${threshold}%를 넘어 페이지가 차단되었습니다.`;
    case "clean":
      return `최근 검사 결과는 정상이며 현재 위험 점수는 ${state.scan.score}%입니다.`;
    case "warning":
      return buildWarningText(state.scan, threshold);
    case "error":
      return "원격 분류기에 연결하지 못했고, 로컬 규칙만으로는 차단 기준에 도달하지 않았습니다.";
    case "disabled":
      return "실시간 차단이 비활성 상태입니다.";
    default:
      return "현재 검사 상태를 확인할 수 없습니다.";
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

function buildHistoryMeta(item) {
  const timeText = new Date(item.checkedAt).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const status = statusMap[item.status]?.label || "기록";
  const source = item.source === "remote" ? "원격 분류기" : "로컬 규칙";
  const reason = item.reason ? ` ${item.reason}` : "";

  return `${timeText} · ${status} · ${source}${reason}`;
}

function buildHeroDetail(state) {
  const host = state.currentHost || "현재 탭";
  const remoteMode = state.remoteProtection.mode === "remote" ? "원격 보호 사용" : "로컬 보호 사용";
  return `${host} 기준으로 ${remoteMode} 상태이며, 최근 검사 ${state.stats.totalScans}건 중 ${state.stats.blockedCount}건이 차단되었습니다.`;
}

function renderReloadButton(button, tab, state) {
  if (!tab?.id) {
    button.disabled = true;
    button.textContent = "재검사 불가";
    return;
  }

  button.disabled = false;
  button.textContent = isSupportedTabUrl(tab.url) || !state?.scan?.url
    ? "현재 탭 재검사"
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

function clampPercentage(value) {
  const numericValue = Number(value);

  if (Number.isNaN(numericValue)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}
