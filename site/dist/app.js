const menu = document.querySelector("[data-menu]");
const links = document.querySelector("[data-links]");
const header = document.querySelector("[data-header]");

document.documentElement.classList.add("has-js");

if (menu instanceof HTMLButtonElement && links instanceof HTMLElement) {
  menu.addEventListener("click", () => {
    const isOpen = menu.getAttribute("aria-expanded") === "true";
    menu.setAttribute("aria-expanded", String(!isOpen));
    links.classList.toggle("is-open", !isOpen);
  });
}

const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const revealItems = document.querySelectorAll(".reveal");
const revealObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries, observer) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("is-visible");
    observer.unobserve(entry.target);
  }
}, { threshold: 0.16 }) : null;
for (const item of revealItems) revealObserver?.observe(item);
const updateMotion = () => {
  document.documentElement.classList.toggle("has-motion", !motionPreference.matches);
  document.documentElement.classList.toggle("prefers-reduced-motion", motionPreference.matches);
  if (motionPreference.matches || !revealObserver) {
    for (const item of revealItems) item.classList.add("is-visible");
  }
};
updateMotion();
motionPreference.addEventListener("change", updateMotion);

const reactionStage = document.querySelector("[data-reaction-stage]");
if (reactionStage instanceof HTMLElement) {
  for (const image of reactionStage.querySelectorAll(".rise")) {
    const duration = Number.parseFloat(image.style.getPropertyValue("--duration"));
    image.style.setProperty("--delay", `${-(Math.random() * duration).toFixed(2)}s`);
  }
  let inView = false;
  const setPlayback = () => reactionStage.classList.toggle("is-paused", !inView || document.hidden);
  if ("IntersectionObserver" in window) {
    const stageObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      setPlayback();
    }, { threshold: 0.01 });
    stageObserver.observe(reactionStage);
  } else { inView = true; setPlayback(); }
  document.addEventListener("visibilitychange", setPlayback);
}

const dailyReplay = document.querySelector("[data-daily-replay]");
const dailyRows = [...document.querySelectorAll("[data-daily-row]")];
const dailyAnnouncement = document.querySelector("[data-daily-announcement]");
const dailyGardenCell = document.querySelector("[data-daily-garden-cell]");
const dailyGardenCopy = document.querySelector("[data-daily-garden-copy]");
const dailyBoard = {
  beforeReview: "/assets/fictional-four-day-board-before-review.png",
  complete: "/assets/fictional-four-day-board-complete.png",
};
const dailyPreview = document.querySelector("#preview");
const dailySequence = [["goal", 360], ["ack", 740], ["morning-peer", 1300], ["review-prompt", 360], ["reflection", 360], ["completion", 360], ["evening-peer", 0]];
const dailyCompleteHold = 3000;
const dailyResetHold = 1000;
let dailyTimer = null;
let dailyTimerStartedAt = 0;
let dailyTimerDelay = 0;
let dailyTimerRemaining = 0;
let dailyStep = 0;
let dailyPhase = "idle";
let dailyInView = false;
let dailyManuallyPaused = false;

const announceDaily = (message) => {
  if (dailyAnnouncement instanceof HTMLElement) dailyAnnouncement.textContent = message;
};
const setDailyGarden = (completed) => {
  if (dailyGardenCell instanceof HTMLImageElement) {
    dailyGardenCell.src = completed ? dailyBoard.complete : dailyBoard.beforeReview;
    dailyGardenCell.alt = completed
      ? "가상 예시의 완료된 Day 1부터 Day 4 보드"
      : "가상 예시의 회고 전 Day 1부터 Day 4 보드";
  }
  if (dailyGardenCopy instanceof HTMLElement) dailyGardenCopy.textContent = completed ? "DAY 1–3 · 완료 체크, DAY 4 · 예정" : "DAY 1–2 · 완료 체크, DAY 3 · 기록, DAY 4 · 예정";
};
const clearDailyTimer = () => {
  if (dailyTimer !== null) {
    dailyTimerRemaining = Math.max(0, dailyTimerDelay - (performance.now() - dailyTimerStartedAt));
    window.clearTimeout(dailyTimer);
    dailyTimer = null;
  }
};
const revealDailyRow = (name) => {
  const row = document.querySelector(`[data-daily-row="${name}"]`);
  if (!(row instanceof HTMLElement)) return;
  row.classList.add("is-visible");
  row.removeAttribute("aria-hidden");
};
const resetDailyPreview = () => {
  for (const row of dailyRows) {
    row.classList.remove("is-visible");
    row.setAttribute("aria-hidden", "true");
  }
  setDailyGarden(false);
};
const setDailyControl = () => {
  if (!(dailyReplay instanceof HTMLButtonElement)) return;
  const isPlaying = dailyPhase !== "idle" && !dailyManuallyPaused;
  dailyReplay.textContent = isPlaying ? "일시정지" : "다시 재생";
  dailyReplay.setAttribute("aria-label", isPlaying ? "하루 예시 재생을 일시정지" : "하루 예시 재생을 다시 시작");
};
const showDailyPreviewImmediately = () => {
  clearDailyTimer();
  dailyPhase = "idle";
  for (const row of dailyRows) {
    row.classList.add("is-visible");
    row.removeAttribute("aria-hidden");
  }
  setDailyGarden(true);
  if (dailyReplay instanceof HTMLButtonElement) {
    dailyReplay.textContent = "하루 예시 완료";
    dailyReplay.disabled = true;
  }
};
const scheduleDaily = (delay, action) => {
  dailyTimerDelay = delay;
  dailyTimerRemaining = delay;
  dailyTimerStartedAt = performance.now();
  dailyTimer = window.setTimeout(() => {
    dailyTimer = null;
    action();
  }, delay);
};

if (dailyReplay instanceof HTMLButtonElement && dailyRows.length > 0) {
  const advanceDailyPreview = () => {
    if (dailyPhase === "playing") {
      const next = dailySequence[dailyStep];
      if (next) {
        const [name, delay] = next;
        dailyStep += 1;
        revealDailyRow(name);
        if (name === "completion") setDailyGarden(true);
        scheduleDaily(delay, advanceDailyPreview);
        return;
      }
      dailyPhase = "complete";
      scheduleDaily(dailyCompleteHold, advanceDailyPreview);
      return;
    }
    if (dailyPhase === "complete") {
      resetDailyPreview();
      dailyPhase = "reset";
      scheduleDaily(dailyResetHold, advanceDailyPreview);
      return;
    }
    if (dailyPhase === "reset") startDailyPreview();
  };
  const startDailyPreview = () => {
    clearDailyTimer();
    resetDailyPreview();
    dailyPhase = "playing";
    dailyStep = 0;
    advanceDailyPreview();
    setDailyControl();
  };
  const pauseDailyPreview = () => {
    clearDailyTimer();
    setDailyControl();
  };
  const resumeDailyPreview = () => {
    if (dailyPhase === "idle") startDailyPreview();
    else if (dailyTimer === null) scheduleDaily(dailyTimerRemaining, advanceDailyPreview);
    setDailyControl();
  };
  const shouldPlayDailyPreview = () => !motionPreference.matches && dailyInView && !document.hidden && !dailyManuallyPaused;
  const syncDailyPreview = () => {
    if (motionPreference.matches) {
      showDailyPreviewImmediately();
      return;
    }
    dailyReplay.disabled = false;
    if (shouldPlayDailyPreview()) resumeDailyPreview();
    else pauseDailyPreview();
  };
  dailyReplay.addEventListener("click", () => {
    dailyManuallyPaused = !dailyManuallyPaused;
    if (dailyManuallyPaused) {
      pauseDailyPreview();
      announceDaily("하루 예시 재생을 멈췄습니다.");
    } else {
      announceDaily("하루 예시 재생을 다시 시작합니다.");
      syncDailyPreview();
    }
  });
  if ("IntersectionObserver" in window && dailyPreview instanceof HTMLElement) {
    const dailyObserver = new IntersectionObserver(([entry]) => {
      dailyInView = entry.isIntersecting && entry.intersectionRatio >= 0.16;
      syncDailyPreview();
    }, { threshold: [0, 0.16] });
    dailyObserver.observe(dailyPreview);
  } else dailyInView = true;
  document.addEventListener("visibilitychange", syncDailyPreview);
  motionPreference.addEventListener("change", () => {
    dailyManuallyPaused = false;
    syncDailyPreview();
  });
  syncDailyPreview();
}

window.addEventListener("scroll", () => header?.classList.toggle("is-scrolled", window.scrollY > 24), { passive: true });

const copyButton = document.querySelector("[data-copy]");
const copyStatus = document.querySelector("#copy-status");
if (copyButton instanceof HTMLButtonElement && copyStatus instanceof HTMLElement) {
  copyButton.addEventListener("click", async () => {
    const text = document.querySelector("#share-copy")?.textContent?.trim() ?? "";
    try { await navigator.clipboard.writeText(text); copyStatus.textContent = "복사했습니다."; }
    catch { const fallback = document.createElement("textarea"); fallback.value = text; fallback.readOnly = true; fallback.className = "copy-fallback"; document.body.append(fallback); fallback.select(); const copied = document.execCommand("copy"); fallback.remove(); copyStatus.textContent = copied ? "복사했습니다." : "복사할 수 없어요. 문구를 직접 선택해 주세요."; }
  });
}
const applicationForm = document.querySelector("[data-application-form]");
if (applicationForm instanceof HTMLFormElement) {
  applicationForm.addEventListener("submit", () => {
    const submit = applicationForm.querySelector("[data-submit]");
    const status = applicationForm.querySelector("[data-form-status]");
    if (submit instanceof HTMLButtonElement) submit.disabled = true;
    if (status instanceof HTMLElement) status.textContent = "신청을 안전하게 보내고 있어요.";
  });
}
