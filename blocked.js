document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";

  const scoreText = document.getElementById("score-text");
  const scoreFill = document.getElementById("score-fill");
  const thresholdText = document.getElementById("threshold-text");
  const hostText = document.getElementById("host-text");
  const sourceText = document.getElementById("source-text");
  const reasonList = document.getElementById("reason-list");
  const urlText = document.getElementById("url-text");
  const trustButton = document.getElementById("trust-button");
  const allowOnceButton = document.getElementById("allow-once-button");
  const backButton = document.getElementById("back-button");

  const setExpiredState = (message) => {
    scoreText.textContent = "0%";
    scoreFill.style.width = "0%";
    thresholdText.textContent = message;
    hostText.textContent = "-";
    sourceText.textContent = "확인 불가";
    urlText.textContent = "";
    renderReasons(reasonList, [message]);
    setBusyState([trustButton, allowOnceButton], true);
  };

  if (!token) {
    setExpiredState("차단 세션 정보가 없습니다.");
  } else {
    const response = await chrome.runtime.sendMessage({
      type: "getBlockedNavigationContext",
      token
    });

    if (!response.ok || !response.context) {
      setExpiredState(response.error || "차단 세션이 만료되었습니다.");
    } else {
      renderContext(response.context);
    }
  }

  trustButton.addEventListener("click", async () => {
    await resolveBlockedAction("trust");
  });

  allowOnceButton.addEventListener("click", async () => {
    await resolveBlockedAction("allow-once");
  });

  backButton.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    window.close();
  });

  async function resolveBlockedAction(action) {
    if (!token) {
      return;
    }

    setBusyState([trustButton, allowOnceButton], true);

    const response = await chrome.runtime.sendMessage({
      type: "resolveBlockedNavigation",
      token,
      action
    });

    if (response.ok) {
      return;
    }

    renderReasons(reasonList, [response.error || "요청한 작업을 완료하지 못했습니다."]);
    setBusyState([trustButton, allowOnceButton], false);
  }

  function renderContext(context) {
    const score = clampPercentage(context.score);
    const threshold = clampPercentage(context.threshold);

    scoreText.textContent = `${score}%`;
    scoreFill.style.width = `${score}%`;
    thresholdText.textContent = `위험 점수 ${score}%가 차단 기준 ${threshold}%를 넘어 접속이 차단되었습니다.`;
    hostText.textContent = context.hostname || "알 수 없음";
    sourceText.textContent = context.source === "remote" ? "원격 분류기" : "로컬 규칙";
    urlText.textContent = context.url || "";
    renderReasons(reasonList, context.reasons);
  }
});

function renderReasons(container, reasons) {
  container.textContent = "";

  const reasonItems = Array.isArray(reasons) && reasons.length > 0
    ? reasons
    : ["위험 점수가 설정한 차단 기준을 초과했습니다."];

  for (const reason of reasonItems) {
    const li = document.createElement("li");
    li.textContent = reason;
    container.appendChild(li);
  }
}

function setBusyState(buttons, busy) {
  for (const button of buttons) {
    button.disabled = busy;
  }
}

function clampPercentage(value) {
  const numericValue = Number(value);

  if (Number.isNaN(numericValue)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}
