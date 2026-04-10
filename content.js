const MAX_HTML_LENGTH = 250000;
const MAX_VISIBLE_TEXT_LENGTH = 12000;
const MAX_HEADING_COUNT = 20;
const MAX_LINK_COUNT = 40;
const MAX_FORM_COUNT = 8;
const MAX_FIELDS_PER_FORM = 20;
const RESCAN_DELAY_MS = 400;
const MAX_FINGERPRINT_LENGTH = 6000;

if (window.top === window && (location.protocol === "http:" || location.protocol === "https:")) {
  let scanTimer = null;
  let lastScannedUrl = "";
  let lastScanFingerprint = "";
  let pendingForceScan = false;

  const runDetection = async (force = false) => {
    const currentUrl = window.location.href;

    const { enabled = true } = await chrome.storage.sync.get(["enabled"]);

    if (!enabled) {
      return;
    }

    const analysisPayload = buildAnalysisPayload();
    const scanFingerprint = buildScanFingerprint(currentUrl, analysisPayload);

    if (!force && currentUrl === lastScannedUrl && scanFingerprint === lastScanFingerprint) {
      return;
    }

    lastScannedUrl = currentUrl;
    lastScanFingerprint = scanFingerprint;

    try {
      await chrome.runtime.sendMessage({
        type: "scanPage",
        url: currentUrl,
        analysisUrl: analysisPayload.analysisUrl,
        htmlSnapshot: analysisPayload.htmlSnapshot,
        pageTitle: analysisPayload.pageTitle
      });
    } catch (error) {
      console.debug("Illegal Site Detector scan skipped:", error);
    }
  };

  const scheduleDetection = (force = false) => {
    if (scanTimer !== null) {
      window.clearTimeout(scanTimer);
    }

    pendingForceScan = pendingForceScan || force;

    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      const shouldForceScan = pendingForceScan;
      pendingForceScan = false;
      runDetection(shouldForceScan).catch((error) => {
        console.debug("페이지 재검사를 완료하지 못했습니다:", error);
      });
    }, RESCAN_DELAY_MS);
  };

  const patchHistoryMethod = (methodName) => {
    const originalMethod = history[methodName];

    history[methodName] = function (...args) {
      const result = originalMethod.apply(this, args);
      scheduleDetection();
      return result;
    };
  };

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");

  window.addEventListener("popstate", scheduleDetection);
  window.addEventListener("hashchange", scheduleDetection);
  window.addEventListener("focus", scheduleDetection);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    if (changes.enabled?.newValue === true) {
      scheduleDetection(true);
      return;
    }

    if (changes.threshold) {
      scheduleDetection(true);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scheduleDetection();
      observeMeaningfulMutations(scheduleDetection);
    }, { once: true });
  } else {
    scheduleDetection();
    observeMeaningfulMutations(scheduleDetection);
  }
}

function buildAnalysisPayload() {
  const analysisUrl = sanitizeUrlForAnalysis(window.location.href);
  const title = redactSensitiveText(normalizeText(document.title || ""));
  const headings = collectHeadings();
  const links = collectLinks();
  const forms = collectForms();
  const visibleText = collectVisibleText(MAX_VISIBLE_TEXT_LENGTH);
  const hasPasswordField = Boolean(document.querySelector("input[type='password']"));
  const hasPaymentField = Boolean(
    document.querySelector(
      "input[autocomplete='cc-number'], input[autocomplete='cc-csc'], input[name*='card' i], input[id*='card' i], input[name*='cvv' i], input[id*='cvv' i]"
    )
  );

  const parts = [
    "<!DOCTYPE html><html><head>",
    `<title>${escapeHtml(title)}</title>`,
    "</head><body>",
    `<main data-analysis-url="${escapeHtml(analysisUrl)}" data-password-field="${String(hasPasswordField)}" data-payment-field="${String(hasPaymentField)}">`,
    "<section id=\"headings\">",
    headings,
    "</section>",
    "<section id=\"forms\">",
    forms,
    "</section>",
    "<section id=\"links\">",
    links,
    "</section>",
    "<section id=\"visible-text\">",
    escapeHtml(visibleText),
    "</section>",
    "</main></body></html>"
  ];

  return {
    analysisUrl,
    htmlSnapshot: parts.join("").slice(0, MAX_HTML_LENGTH),
    pageTitle: title
  };
}

function buildScanFingerprint(currentUrl, analysisPayload) {
  return [
    sanitizeUrlForAnalysis(currentUrl),
    analysisPayload.pageTitle,
    analysisPayload.htmlSnapshot.slice(0, MAX_FINGERPRINT_LENGTH)
  ].join("::");
}

function observeMeaningfulMutations(onMeaningfulChange) {
  if (!document.documentElement) {
    return;
  }

  const observer = new MutationObserver((mutations) => {
    if (!hasMeaningfulMutation(mutations)) {
      return;
    }

    onMeaningfulChange();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function hasMeaningfulMutation(mutations) {
  for (const mutation of mutations) {
    if (mutation.type === "characterData") {
      const parentTagName = mutation.target.parentElement?.tagName?.toLowerCase() || "";

      if (["title", "h1", "h2", "h3", "a", "button", "label", "p", "span"].includes(parentTagName)) {
        return true;
      }

      continue;
    }

    if (mutation.type !== "childList") {
      continue;
    }

    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];

    for (const node of changedNodes) {
      if (!(node instanceof Element)) {
        continue;
      }

      if (node.matches("form, input, textarea, select, a, h1, h2, h3, button, title")) {
        return true;
      }

      if (node.querySelector("form, input, textarea, select, a, h1, h2, h3, button")) {
        return true;
      }
    }
  }

  return false;
}

function collectHeadings() {
  return Array.from(document.querySelectorAll("h1, h2, h3"))
    .slice(0, MAX_HEADING_COUNT)
    .map((heading) => normalizeText(heading.textContent || ""))
    .filter(Boolean)
    .map((text) => `<h>${escapeHtml(redactSensitiveText(text))}</h>`)
    .join("");
}

function collectLinks() {
  return Array.from(document.querySelectorAll("a[href]"))
    .slice(0, MAX_LINK_COUNT)
    .map((anchor) => {
      const href = sanitizeUrlForAnalysis(anchor.href);
      const text = redactSensitiveText(normalizeText(anchor.textContent || ""));

      if (!href && !text) {
        return "";
      }

      return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
    })
    .filter(Boolean)
    .join("");
}

function collectForms() {
  return Array.from(document.forms)
    .slice(0, MAX_FORM_COUNT)
    .map((form) => {
      const method = normalizeText((form.method || "GET").toUpperCase());
      const action = sanitizeUrlForAnalysis(form.action || window.location.href);
      const fields = Array.from(form.elements)
        .slice(0, MAX_FIELDS_PER_FORM)
        .map((element) => summarizeFormElement(element))
        .filter(Boolean)
        .join("");

      return `<form method="${escapeHtml(method)}" action="${escapeHtml(action)}">${fields}</form>`;
    })
    .join("");
}

function summarizeFormElement(element) {
  if (!element || !element.tagName) {
    return "";
  }

  const tagName = element.tagName.toLowerCase();

  if (tagName === "input") {
    const type = normalizeText((element.getAttribute("type") || "text").toLowerCase());
    const autocomplete = normalizeText((element.getAttribute("autocomplete") || "").toLowerCase());
    return `<input type="${escapeHtml(type)}" autocomplete="${escapeHtml(autocomplete)}" redacted="true"></input>`;
  }

  if (tagName === "textarea") {
    return "<textarea redacted=\"true\"></textarea>";
  }

  if (tagName === "select") {
    return `<select option-count="${String(element.options?.length ?? 0)}" redacted="true"></select>`;
  }

  if (tagName === "button") {
    const type = normalizeText((element.getAttribute("type") || "button").toLowerCase());
    const text = redactSensitiveText(normalizeText(element.textContent || ""));
    return `<button type="${escapeHtml(type)}">${escapeHtml(text)}</button>`;
  }

  return "";
}

function collectVisibleText(maxLength) {
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let totalLength = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parentTagName = node.parentElement?.tagName?.toLowerCase() || "";

    if (["script", "style", "noscript", "svg", "canvas", "template"].includes(parentTagName)) {
      continue;
    }

    const text = redactSensitiveText(normalizeText(node.textContent || ""));

    if (!text) {
      continue;
    }

    chunks.push(text);
    totalLength += text.length + 1;

    if (totalLength >= maxLength) {
      break;
    }
  }

  return chunks.join(" ").slice(0, maxLength);
}

function sanitizeUrlForAnalysis(urlLike) {
  try {
    const parsed = new URL(urlLike, window.location.href);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function redactSensitiveText(text) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[redacted-card]")
    .replace(/\b[A-Za-z0-9+/_=-]{24,}\b/g, "[redacted-token]");
}

function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
