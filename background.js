const API_ENDPOINT = "http://uskawjdu.iptime.org:8080/predict";
const DEFAULT_SETTINGS = Object.freeze({
  threshold: 60,
  enabled: true,
  trustedDomains: []
});
const DEFAULT_LOCAL_STATE = Object.freeze({
  lastScanByTab: {},
  scanHistory: []
});
const DEFAULT_SESSION_STATE = Object.freeze({
  sessionAllowlist: [],
  blockedNavigationByToken: {}
});
const REQUEST_TIMEOUT_MS = 7000;
const MAX_REASON_COUNT = 4;
const BLOCKED_NAVIGATION_TTL_MS = 15 * 60 * 1000;
const MAX_HISTORY_ITEMS = 40;
const DASHBOARD_HISTORY_ITEMS = 12;
const DEFAULT_ACTION_TITLE = "불법 사이트 탐지기";

const ACTION_STYLES = Object.freeze({
  blocked: { color: "#b23a2f", text: null },
  clean: { color: "#237a57", text: "OK" },
  warning: { color: "#c17b14", text: null },
  error: { color: "#6b7280", text: "ERR" },
  disabled: { color: "#6b7280", text: "OFF" },
  trusted: { color: "#237a57", text: "TR" },
  "session-allowed": { color: "#c17b14", text: "1회" },
  pending: { color: "#6b7280", text: "..." }
});

let rulesConfigPromise;

chrome.runtime.onInstalled.addListener(async () => {
  await initializeExtension();
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeExtension();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await safeGetTab(tabId);
  await refreshActionForTab(tabId, tab?.url);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url ?? tab?.url;

  if (changeInfo.status === "loading") {
    await showPendingActionState(tabId, nextUrl);
    return;
  }

  if (changeInfo.status === "complete" || changeInfo.url) {
    await refreshActionForTab(tabId, nextUrl);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeTabState(tabId);
  await clearActionPresentation(tabId);
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (!["local", "sync", "session"].includes(areaName)) {
    return;
  }

  refreshActiveTabActionState().catch((error) => {
    console.debug("활성 탭 배지 갱신을 건너뛰었습니다:", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("메시지 처리 중 오류가 발생했습니다:", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "scanPage":
      assertContentScriptSender(sender);
      return handleScanPage(message, sender);
    case "getTabState":
      assertExtensionPageSender(sender);
      return getTabState(message);
    case "getDashboardState":
      assertExtensionPageSender(sender);
      return getDashboardState(message);
    case "saveSettings":
      assertExtensionPageSender(sender);
      return saveSettings(message.payload ?? {});
    case "setTrustedDomain":
      assertExtensionPageSender(sender);
      return setTrustedDomain(message.url ?? message.hostname, Boolean(message.trusted));
    case "setSessionAllowance":
      assertExtensionPageSender(sender);
      return setSessionAllowance(message.url ?? message.hostname, Boolean(message.allowed));
    case "clearSessionAllowlist":
      assertExtensionPageSender(sender);
      return clearSessionAllowlist();
    case "clearScanHistory":
      assertExtensionPageSender(sender);
      return clearScanHistory();
    case "getBlockedNavigationContext":
      assertExtensionPageSender(sender);
      return getBlockedNavigationContext(message.token);
    case "resolveBlockedNavigation":
      assertExtensionPageSender(sender);
      return resolveBlockedNavigation(message.token, message.action);
    default:
      return { ok: false, error: `알 수 없는 메시지 타입입니다: ${message?.type ?? "undefined"}` };
  }
}

function assertContentScriptSender(sender) {
  if (sender?.id !== chrome.runtime.id || sender?.tab?.id === undefined) {
    throw new Error("scanPage 요청은 이 확장프로그램의 콘텐츠 스크립트에서만 보낼 수 있습니다.");
  }
}

function assertExtensionPageSender(sender) {
  const runtimePrefix = chrome.runtime.getURL("");

  if (sender?.id !== chrome.runtime.id || typeof sender?.url !== "string" || !sender.url.startsWith(runtimePrefix)) {
    throw new Error("이 작업은 확장프로그램 페이지에서만 요청할 수 있습니다.");
  }
}

async function initializeExtension() {
  await ensureStorageDefaults(chrome.storage.sync, DEFAULT_SETTINGS);
  await ensureStorageDefaults(chrome.storage.local, DEFAULT_LOCAL_STATE);
  await configureSessionStorage();
  await migrateLegacyLocalSessionState();
  await configureSidePanel();
  await refreshActiveTabActionState();
}

async function ensureStorageDefaults(storageArea, defaults) {
  const stored = await storageArea.get(Object.keys(defaults));
  const patch = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (stored[key] === undefined) {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length > 0) {
    await storageArea.set(patch);
  }
}

async function configureSessionStorage() {
  if (chrome.storage.session?.setAccessLevel) {
    try {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch (error) {
      console.debug("storage.session 접근 수준을 기본값으로 유지합니다:", error);
    }
  }

  await ensureStorageDefaults(getSessionStorageArea(), DEFAULT_SESSION_STATE);
}

async function migrateLegacyLocalSessionState() {
  if (!chrome.storage.session) {
    return;
  }

  const legacyKeys = ["sessionAllowlist", "blockedNavigationByToken"];
  const legacyState = await chrome.storage.local.get(legacyKeys);
  const sessionArea = getSessionStorageArea();
  const sessionState = await sessionArea.get(Object.keys(DEFAULT_SESSION_STATE));
  const patch = {};
  const removeKeys = [];

  if (
    Array.isArray(legacyState.sessionAllowlist) &&
    legacyState.sessionAllowlist.length > 0 &&
    (!Array.isArray(sessionState.sessionAllowlist) || sessionState.sessionAllowlist.length === 0)
  ) {
    patch.sessionAllowlist = normalizeDomainList(legacyState.sessionAllowlist);
    removeKeys.push("sessionAllowlist");
  }

  if (
    legacyState.blockedNavigationByToken &&
    Object.keys(legacyState.blockedNavigationByToken).length > 0 &&
    (!sessionState.blockedNavigationByToken || Object.keys(sessionState.blockedNavigationByToken).length === 0)
  ) {
    patch.blockedNavigationByToken = legacyState.blockedNavigationByToken;
    removeKeys.push("blockedNavigationByToken");
  }

  if (Object.keys(patch).length > 0) {
    await sessionArea.set(patch);
  }

  if (removeKeys.length > 0) {
    await chrome.storage.local.remove(removeKeys);
  }
}

async function configureSidePanel() {
  if (!chrome.sidePanel?.setOptions) {
    return;
  }

  try {
    await chrome.sidePanel.setOptions({
      path: "sidepanel.html",
      enabled: true
    });
  } catch (error) {
    console.debug("사이드 패널 초기화는 지원되지 않는 브라우저에서 건너뜁니다:", error);
  }
}

function getSessionStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));

  return {
    threshold: clampPercentage(stored.threshold ?? DEFAULT_SETTINGS.threshold),
    enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
    trustedDomains: normalizeDomainList(stored.trustedDomains ?? DEFAULT_SETTINGS.trustedDomains)
  };
}

async function getLocalState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_LOCAL_STATE));

  return {
    lastScanByTab: stored.lastScanByTab ?? {},
    scanHistory: Array.isArray(stored.scanHistory) ? stored.scanHistory : []
  };
}

async function getSessionState() {
  const stored = await getSessionStorageArea().get(Object.keys(DEFAULT_SESSION_STATE));

  return {
    sessionAllowlist: normalizeDomainList(stored.sessionAllowlist ?? DEFAULT_SESSION_STATE.sessionAllowlist),
    blockedNavigationByToken: stored.blockedNavigationByToken ?? {}
  };
}

async function saveSettings(payload) {
  const patch = {};

  if (payload.threshold !== undefined) {
    patch.threshold = clampPercentage(payload.threshold);
  }

  if (payload.enabled !== undefined) {
    patch.enabled = Boolean(payload.enabled);
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.sync.set(patch);
  }

  const settings = await getSettings();
  await refreshActiveTabActionState();

  return {
    ok: true,
    settings
  };
}

async function getRulesConfig() {
  if (!rulesConfigPromise) {
    rulesConfigPromise = fetch(chrome.runtime.getURL("rules.json"))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`rules.json을 불러오지 못했습니다. (${response.status})`);
        }

        return response.json();
      })
      .catch((error) => {
        console.error("로컬 규칙을 불러오지 못했습니다:", error);
        return { urlIndicators: [], htmlIndicators: [] };
      });
  }

  return rulesConfigPromise;
}

async function handleScanPage(message, sender) {
  const tabId = sender.tab?.id;
  const originalUrl = message.url;

  if (!originalUrl || !isSupportedUrl(originalUrl) || tabId === undefined) {
    return { ok: true, status: "ignored" };
  }

  const settings = await getSettings();
  const hostname = extractHostname(originalUrl);
  const safeStoredUrl = sanitizeAnalysisUrl(originalUrl);

  if (!hostname) {
    return { ok: true, status: "ignored" };
  }

  if (!settings.enabled) {
    await storeLastScan(tabId, {
      status: "disabled",
      url: safeStoredUrl,
      hostname,
      threshold: settings.threshold,
      checkedAt: Date.now(),
      pageTitle: sanitizeTitle(message.pageTitle)
    });

    return { ok: true, status: "disabled" };
  }

  if (settings.trustedDomains.includes(hostname)) {
    await storeLastScan(tabId, {
      status: "trusted",
      url: safeStoredUrl,
      hostname,
      threshold: settings.threshold,
      checkedAt: Date.now(),
      pageTitle: sanitizeTitle(message.pageTitle)
    });

    return { ok: true, status: "trusted" };
  }

  const sessionState = await getSessionState();

  if (sessionState.sessionAllowlist.includes(hostname)) {
    await storeLastScan(tabId, {
      status: "session-allowed",
      url: safeStoredUrl,
      hostname,
      threshold: settings.threshold,
      checkedAt: Date.now(),
      pageTitle: sanitizeTitle(message.pageTitle)
    });

    return { ok: true, status: "session-allowed" };
  }

  const analysisUrl = sanitizeAnalysisUrl(message.analysisUrl ?? originalUrl);
  const htmlSnapshot = limitAnalysisSnapshot(message.htmlSnapshot ?? "");
  const localVerdict = await evaluateLocalRules(analysisUrl, htmlSnapshot);
  const remoteVerdict = await fetchRemoteVerdict(analysisUrl, htmlSnapshot);
  const effectiveVerdict = remoteVerdict.score !== null ? remoteVerdict : localVerdict;
  const score = clampPercentage(effectiveVerdict.score ?? 0);
  const reasons = mergeReasons(remoteVerdict.reasons, localVerdict.reasons).slice(0, MAX_REASON_COUNT);
  const shouldBlock = score >= settings.threshold;
  const status = buildStatus({
    shouldBlock,
    remoteStatus: remoteVerdict.status,
    score,
    localScore: localVerdict.score
  });

  const scanResult = {
    status,
    url: analysisUrl,
    originalUrl,
    hostname,
    threshold: settings.threshold,
    score,
    source: effectiveVerdict.source,
    reasons,
    checkedAt: Date.now(),
    remoteStatus: remoteVerdict.status,
    remoteError: remoteVerdict.error,
    pageTitle: sanitizeTitle(message.pageTitle)
  };

  await storeLastScan(tabId, scanResult);

  if (shouldBlock) {
    await redirectToBlockedPage(tabId, scanResult);
  }

  return {
    ok: true,
    status,
    score
  };
}

function buildStatus({ shouldBlock, remoteStatus, score, localScore }) {
  if (shouldBlock) {
    return "blocked";
  }

  if (score > 0) {
    return "warning";
  }

  if (remoteStatus === "request-error" && localScore === 0) {
    return "error";
  }

  return "clean";
}

async function fetchRemoteVerdict(url, html) {
  const endpointState = getRemoteEndpointState();

  if (!endpointState.enabled) {
    return {
      source: "remote",
      score: null,
      reasons: [],
      error: endpointState.reason,
      status: endpointState.status
    };
  }

  if (shouldBypassRemoteScan(url)) {
    return {
      source: "remote",
      score: null,
      reasons: [],
      error: "사설망 또는 로컬 주소는 원격 분석을 건너뜁니다.",
      status: "private-target"
    };
  }

  if (!html) {
    return {
      source: "remote",
      score: null,
      reasons: [],
      error: "정제된 페이지 스냅샷이 비어 있습니다.",
      status: "snapshot-empty"
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpointState.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url, html }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`서버가 ${response.status} 상태 코드를 반환했습니다.`);
    }

    const data = await response.json();
    const score = normalizeScore(
      data.illegalPercent ??
      data.score ??
      data.probability ??
      data.riskScore ??
      data.risk
    );

    return {
      source: "remote",
      score,
      reasons: extractReasons(data),
      error: null,
      status: "ok"
    };
  } catch (error) {
    return {
      source: "remote",
      score: null,
      reasons: [],
      error: error.name === "AbortError" ? "분석 요청 시간이 초과되었습니다." : error.message,
      status: "request-error"
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function evaluateLocalRules(url, html) {
  const rules = await getRulesConfig();
  const matches = [];
  let score = 0;

  score += evaluateIndicators(url, rules.urlIndicators ?? [], matches);
  score += evaluateIndicators(html, rules.htmlIndicators ?? [], matches);

  return {
    source: "local",
    score: clampPercentage(score),
    reasons: matches
  };
}

function evaluateIndicators(source, indicators, matches) {
  let total = 0;

  for (const indicator of indicators) {
    const regex = buildRegex(indicator.pattern);

    if (!regex) {
      continue;
    }

    if (regex.test(source)) {
      total += Number(indicator.score) || 0;
      matches.push(indicator.description || indicator.pattern);
    }
  }

  return total;
}

function buildRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    console.warn("rules.json에 잘못된 정규식 패턴이 있습니다:", pattern, error);
    return null;
  }
}

function extractReasons(data) {
  const reasons = [];

  if (typeof data.reason === "string" && data.reason.trim()) {
    reasons.push(data.reason.trim());
  }

  if (typeof data.message === "string" && data.message.trim()) {
    reasons.push(data.message.trim());
  }

  if (Array.isArray(data.reasons)) {
    reasons.push(...data.reasons.filter(Boolean));
  }

  if (Array.isArray(data.signals)) {
    reasons.push(...data.signals.filter(Boolean));
  }

  return mergeReasons(reasons);
}

function mergeReasons(...reasonGroups) {
  return [...new Set(reasonGroups.flat().filter(Boolean).map((reason) => String(reason).trim()))];
}

function normalizeScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  const numericValue = Number(value);

  if (numericValue > 0 && numericValue < 1) {
    return clampPercentage(Math.round(numericValue * 100));
  }

  return clampPercentage(Math.round(numericValue));
}

async function redirectToBlockedPage(tabId, scanResult) {
  const token = await storeBlockedNavigationContext(tabId, scanResult);
  const blockedPageUrl = `${chrome.runtime.getURL("blocked.html")}?token=${encodeURIComponent(token)}`;
  await chrome.tabs.update(tabId, { url: blockedPageUrl });
}

async function storeLastScan(tabId, scanResult) {
  const { lastScanByTab = {}, scanHistory = [] } = await chrome.storage.local.get(["lastScanByTab", "scanHistory"]);
  const storedScanResult = {
    ...scanResult
  };

  delete storedScanResult.originalUrl;

  const previousScan = lastScanByTab[String(tabId)] ?? null;
  const nextHistory = shouldTrackHistory(previousScan, storedScanResult)
    ? [buildHistoryEntry(storedScanResult), ...scanHistory].slice(0, MAX_HISTORY_ITEMS)
    : scanHistory;

  await chrome.storage.local.set({
    lastScanByTab: {
      ...lastScanByTab,
      [String(tabId)]: storedScanResult
    },
    scanHistory: nextHistory
  });

  await refreshActionForTab(tabId, storedScanResult.url);
}

function shouldTrackHistory(previousScan, nextScan) {
  if (!previousScan) {
    return true;
  }

  const previousSignature = [
    previousScan.url,
    previousScan.status,
    previousScan.score,
    previousScan.threshold,
    previousScan.source
  ].join("|");
  const nextSignature = [
    nextScan.url,
    nextScan.status,
    nextScan.score,
    nextScan.threshold,
    nextScan.source
  ].join("|");

  return previousSignature !== nextSignature;
}

function buildHistoryEntry(scanResult) {
  return {
    id: crypto.randomUUID(),
    checkedAt: scanResult.checkedAt,
    hostname: scanResult.hostname,
    url: scanResult.url,
    pageTitle: scanResult.pageTitle || scanResult.hostname || "제목 없음",
    status: scanResult.status,
    score: clampPercentage(scanResult.score ?? 0),
    threshold: clampPercentage(scanResult.threshold ?? DEFAULT_SETTINGS.threshold),
    source: scanResult.source || "local",
    reason: scanResult.reasons?.[0] || ""
  };
}

async function storeBlockedNavigationContext(tabId, scanResult) {
  const sessionArea = getSessionStorageArea();
  const store = await getPrunedBlockedNavigationStore();
  const token = crypto.randomUUID();

  store[token] = {
    tabId,
    url: scanResult.originalUrl ?? scanResult.url,
    hostname: scanResult.hostname,
    threshold: scanResult.threshold,
    score: scanResult.score,
    source: scanResult.source,
    reasons: scanResult.reasons,
    createdAt: Date.now()
  };

  await sessionArea.set({ blockedNavigationByToken: store });
  return token;
}

async function getBlockedNavigationContext(token) {
  const store = await getPrunedBlockedNavigationStore();
  const context = store[token];

  if (!context) {
    return { ok: false, error: "차단 세션 정보가 없거나 만료되었습니다." };
  }

  return {
    ok: true,
    context: {
      hostname: context.hostname,
      url: context.url,
      threshold: context.threshold,
      score: context.score,
      source: context.source,
      reasons: context.reasons
    }
  };
}

async function resolveBlockedNavigation(token, action) {
  const sessionArea = getSessionStorageArea();
  const store = await getPrunedBlockedNavigationStore();
  const context = store[token];

  if (!context) {
    return { ok: false, error: "차단 세션 정보가 없거나 만료되었습니다." };
  }

  if (action === "trust") {
    await setTrustedDomain(context.url, true);
  } else if (action === "allow-once") {
    await setSessionAllowance(context.url, true);
  } else {
    return { ok: false, error: "지원하지 않는 차단 페이지 동작입니다." };
  }

  await chrome.tabs.update(context.tabId, { url: context.url });
  delete store[token];
  await sessionArea.set({ blockedNavigationByToken: store });

  return { ok: true };
}

async function getPrunedBlockedNavigationStore() {
  const sessionArea = getSessionStorageArea();
  const { blockedNavigationByToken = {} } = await sessionArea.get(["blockedNavigationByToken"]);
  const now = Date.now();
  const nextStore = {};
  let changed = false;

  for (const [token, context] of Object.entries(blockedNavigationByToken)) {
    if (!context || typeof context.createdAt !== "number" || now - context.createdAt > BLOCKED_NAVIGATION_TTL_MS) {
      changed = true;
      continue;
    }

    nextStore[token] = context;
  }

  if (changed) {
    await sessionArea.set({ blockedNavigationByToken: nextStore });
  }

  return nextStore;
}

async function getTabState(message) {
  const settings = await getSettings();
  const localState = await getLocalState();
  const sessionState = await getSessionState();
  const scan = message.tabId !== undefined ? localState.lastScanByTab[String(message.tabId)] ?? null : null;
  const fallbackUrl = scan?.url || "";
  const effectiveUrl = isSupportedUrl(message.url) ? message.url : fallbackUrl;
  const detectedHost = extractHostname(message.url);
  const currentHost = detectedHost || scan?.hostname || "";
  const trusted = currentHost ? settings.trustedDomains.includes(currentHost) : false;
  const sessionAllowed = currentHost ? sessionState.sessionAllowlist.includes(currentHost) : false;

  return {
    ok: true,
    settings,
    currentHost,
    trusted,
    sessionAllowed,
    scan,
    remoteProtection: getRemoteProtectionState(effectiveUrl)
  };
}

async function getDashboardState(message) {
  const tabState = await getTabState(message);
  const localState = await getLocalState();
  const sessionState = await getSessionState();

  return {
    ...tabState,
    recentHistory: localState.scanHistory.slice(0, DASHBOARD_HISTORY_ITEMS),
    trustedDomains: tabState.settings.trustedDomains,
    sessionAllowlist: sessionState.sessionAllowlist,
    stats: buildDashboardStats(localState.scanHistory, tabState.settings, sessionState),
    support: {
      sidePanel: Boolean(chrome.sidePanel?.open)
    }
  };
}

function buildDashboardStats(scanHistory, settings, sessionState) {
  const blockedCount = scanHistory.filter((entry) => entry.status === "blocked").length;
  const riskCount = scanHistory.filter((entry) => ["warning", "blocked"].includes(entry.status)).length;

  return {
    totalScans: scanHistory.length,
    blockedCount,
    riskCount,
    trustedCount: settings.trustedDomains.length,
    sessionCount: sessionState.sessionAllowlist.length
  };
}

async function setTrustedDomain(target, trusted) {
  const hostname = extractHostnameOrDomain(target);

  if (!hostname) {
    return { ok: false, error: "올바른 사이트 URL 또는 도메인이 필요합니다." };
  }

  const settings = await getSettings();
  const nextTrustedDomains = new Set(settings.trustedDomains);

  if (trusted) {
    nextTrustedDomains.add(hostname);
    await updateSessionAllowlist(hostname, false);
  } else {
    nextTrustedDomains.delete(hostname);
  }

  const trustedDomains = [...nextTrustedDomains].sort();
  await chrome.storage.sync.set({ trustedDomains });
  await refreshActiveTabActionState();

  return {
    ok: true,
    trustedDomains
  };
}

async function setSessionAllowance(target, allowed) {
  const hostname = extractHostnameOrDomain(target);

  if (!hostname) {
    return { ok: false, error: "올바른 사이트 URL 또는 도메인이 필요합니다." };
  }

  const sessionAllowlist = await updateSessionAllowlist(hostname, allowed);
  await refreshActiveTabActionState();

  return {
    ok: true,
    sessionAllowlist
  };
}

async function updateSessionAllowlist(hostname, allowed) {
  const sessionArea = getSessionStorageArea();
  const sessionState = await getSessionState();
  const nextAllowlist = new Set(sessionState.sessionAllowlist);

  if (allowed) {
    nextAllowlist.add(hostname);
  } else {
    nextAllowlist.delete(hostname);
  }

  const sessionAllowlist = [...nextAllowlist].sort();
  await sessionArea.set({ sessionAllowlist });
  return sessionAllowlist;
}

async function clearSessionAllowlist() {
  await getSessionStorageArea().set({ sessionAllowlist: [] });
  await refreshActiveTabActionState();
  return { ok: true };
}

async function clearScanHistory() {
  await chrome.storage.local.set({ scanHistory: [] });
  return { ok: true };
}

function getRemoteProtectionState(currentUrl) {
  const endpointState = getRemoteEndpointState();

  if (!endpointState.enabled) {
    return {
      mode: "local-only",
      display: endpointState.display,
      detail: endpointState.reason
    };
  }

  if (shouldBypassRemoteScan(currentUrl)) {
    return {
      mode: "local-only",
      display: endpointState.display,
      detail: "사설망 또는 로컬 주소는 원격 분석을 수행하지 않습니다."
    };
  }

  return {
    mode: "remote",
    display: endpointState.display,
    detail: "정제된 페이지 스냅샷을 사용해 원격 분류기로 분석합니다."
  };
}

function getRemoteEndpointState() {
  if (!API_ENDPOINT) {
    return {
      enabled: false,
      status: "disabled",
      reason: "안전한 HTTPS 엔드포인트가 설정되기 전까지 원격 분석은 비활성 상태입니다.",
      display: "원격 분류기가 설정되지 않았습니다"
    };
  }

  let endpoint;

  try {
    endpoint = new URL(API_ENDPOINT);
  } catch (error) {
    return {
      enabled: false,
      status: "disabled",
      reason: "엔드포인트 URL이 올바르지 않아 원격 분석이 비활성화되었습니다.",
      display: "잘못된 원격 엔드포인트"
    };
  }

  const isLoopback = isLoopbackHostname(endpoint.hostname);

  if (endpoint.protocol !== "https:" && !isLoopback) {
    return {
      enabled: false,
      status: "disabled",
      reason: "설정된 엔드포인트가 HTTPS가 아니어서 원격 분석을 비활성화했습니다.",
      display: `차단된 비보안 엔드포인트: ${endpoint.origin}`
    };
  }

  return {
    enabled: true,
    status: "ok",
    url: endpoint.toString(),
    display: endpoint.toString()
  };
}

function shouldBypassRemoteScan(url) {
  const hostname = extractHostname(url);
  return isPrivateOrLocalHostname(hostname);
}

function isPrivateOrLocalHostname(hostname) {
  if (!hostname) {
    return true;
  }

  const normalized = hostname.toLowerCase();

  if (isLoopbackHostname(normalized)) {
    return true;
  }

  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".test")
  ) {
    return true;
  }

  if (!normalized.includes(".")) {
    return true;
  }

  if (!isIpv4Address(normalized)) {
    return false;
  }

  const octets = normalized.split(".").map((part) => Number(part));

  if (octets[0] === 10 || octets[0] === 127) {
    return true;
  }

  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }

  if (octets[0] === 169 && octets[1] === 254) {
    return true;
  }

  return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isIpv4Address(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function sanitizeAnalysisUrl(url) {
  if (!isSupportedUrl(url)) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function extractHostnameOrDomain(target) {
  const normalized = String(target ?? "").trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized.includes("://")) {
    return extractHostname(normalized);
  }

  return normalized.replace(/^[./]+/, "").replace(/[/?#].*$/, "");
}

function sanitizeTitle(title) {
  return String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function limitAnalysisSnapshot(htmlSnapshot) {
  return String(htmlSnapshot ?? "").slice(0, 250000);
}

function normalizeDomainList(domains) {
  return [...new Set((domains ?? []).map((domain) => String(domain).trim().toLowerCase()).filter(Boolean))].sort();
}

function extractHostname(url) {
  if (!isSupportedUrl(url)) {
    return "";
  }

  try {
    return new URL(url).hostname.trim().toLowerCase();
  } catch (error) {
    return "";
  }
}

function isSupportedUrl(url) {
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
    return DEFAULT_SETTINGS.threshold;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}

async function refreshActiveTabActionState() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id) {
    return;
  }

  await refreshActionForTab(activeTab.id, activeTab.url);
}

async function refreshActionForTab(tabId, url) {
  if (tabId === undefined) {
    return;
  }

  try {
    const state = await getTabState({ tabId, url });
    const presentation = buildActionPresentation(state);
    await applyActionPresentation(tabId, presentation);
  } catch (error) {
    console.debug("탭 배지 상태를 갱신하지 못했습니다:", error);
  }
}

async function showPendingActionState(tabId, url) {
  if (!tabId || !isSupportedUrl(url)) {
    await clearActionPresentation(tabId);
    return;
  }

  await applyActionPresentation(tabId, {
    text: ACTION_STYLES.pending.text,
    color: ACTION_STYLES.pending.color,
    title: "페이지를 다시 검사하는 중입니다."
  });
}

function buildActionPresentation(state) {
  if (!state.currentHost) {
    return {
      text: "",
      color: ACTION_STYLES.clean.color,
      title: DEFAULT_ACTION_TITLE
    };
  }

  if (!state.settings.enabled) {
    return {
      text: ACTION_STYLES.disabled.text,
      color: ACTION_STYLES.disabled.color,
      title: `${state.currentHost}: 실시간 차단이 꺼져 있습니다.`
    };
  }

  if (state.trusted) {
    return {
      text: ACTION_STYLES.trusted.text,
      color: ACTION_STYLES.trusted.color,
      title: `${state.currentHost}: 신뢰 사이트로 등록되어 있습니다.`
    };
  }

  if (state.sessionAllowed) {
    return {
      text: ACTION_STYLES["session-allowed"].text,
      color: ACTION_STYLES["session-allowed"].color,
      title: `${state.currentHost}: 현재 브라우저 세션 동안 임시 허용되었습니다.`
    };
  }

  if (!state.scan) {
    return {
      text: "",
      color: ACTION_STYLES.clean.color,
      title: `${state.currentHost}: 검사 결과를 기다리는 중입니다.`
    };
  }

  const style = ACTION_STYLES[state.scan.status] || ACTION_STYLES.clean;
  const scoreText = state.scan.status === "blocked" || state.scan.status === "warning"
    ? String(clampPercentage(state.scan.score))
    : style.text;

  return {
    text: scoreText ?? "",
    color: style.color,
    title: buildActionTitle(state)
  };
}

function buildActionTitle(state) {
  if (!state.scan) {
    return `${state.currentHost}: 검사 결과를 기다리는 중입니다.`;
  }

  switch (state.scan.status) {
    case "blocked":
      return `${state.currentHost}: 위험 점수 ${state.scan.score}%로 차단되었습니다.`;
    case "warning":
      return `${state.currentHost}: 위험 점수 ${state.scan.score}%가 감지되었습니다.`;
    case "clean":
      return `${state.currentHost}: 최근 검사 결과는 정상입니다.`;
    case "error":
      return `${state.currentHost}: 원격 분류기 연결에 실패했습니다.`;
    case "disabled":
      return `${state.currentHost}: 실시간 차단이 비활성 상태입니다.`;
    case "trusted":
      return `${state.currentHost}: 신뢰 사이트입니다.`;
    case "session-allowed":
      return `${state.currentHost}: 현재 세션에서 임시 허용되었습니다.`;
    default:
      return DEFAULT_ACTION_TITLE;
  }
}

async function applyActionPresentation(tabId, presentation) {
  try {
    await chrome.action.setBadgeText({ tabId, text: presentation.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: presentation.color });

    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    }

    await chrome.action.setTitle({ tabId, title: presentation.title });
  } catch (error) {
    console.debug("배지 렌더링을 적용하지 못했습니다:", error);
  }
}

async function clearActionPresentation(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
  } catch (error) {
    console.debug("배지 초기화를 건너뛰었습니다:", error);
  }
}

async function removeTabState(tabId) {
  const { lastScanByTab = {} } = await chrome.storage.local.get(["lastScanByTab"]);
  const key = String(tabId);

  if (!(key in lastScanByTab)) {
    return;
  }

  const nextState = {
    ...lastScanByTab
  };

  delete nextState[key];
  await chrome.storage.local.set({ lastScanByTab: nextState });
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}
