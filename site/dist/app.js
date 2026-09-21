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
let dailyTimers = [];
let dailyPlaying = false;

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
const clearDailyPlayback = () => {
  for (const timer of dailyTimers) window.clearTimeout(timer);
  dailyTimers = [];
  dailyPlaying = false;
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
  if (dailyReplay instanceof HTMLButtonElement) dailyReplay.textContent = "하루 재생";
};
const showDailyPreviewImmediately = () => {
  clearDailyPlayback();
  for (const row of dailyRows) {
    row.classList.add("is-visible");
    row.removeAttribute("aria-hidden");
  }
  setDailyGarden(true);
  if (dailyReplay instanceof HTMLButtonElement) dailyReplay.textContent = "다시 보기";
};
const scheduleDaily = (delay, action) => {
  dailyTimers.push(window.setTimeout(action, delay));
};

if (dailyReplay instanceof HTMLButtonElement && dailyRows.length > 0) {
  const applyDailyMotionPreference = () => {
    if (motionPreference.matches) showDailyPreviewImmediately();
    else resetDailyPreview();
  };
  const playDailyPreview = () => {
    if (motionPreference.matches) {
      announceDaily("10시 목표, 동료의 응원, 18시 회고 순서로 읽을 수 있습니다.");
      return;
    }
    clearDailyPlayback();
    resetDailyPreview();
    dailyPlaying = true;
    dailyReplay.textContent = "다시 보기";
    revealDailyRow("goal");
    announceDaily("10시 목표와 봇의 기록 확인을 보여줍니다.");
    scheduleDaily(360, () => revealDailyRow("ack"));
    scheduleDaily(1100, () => {
      revealDailyRow("morning-peer");
      announceDaily("동료의 직접 응원 예시를 보여줍니다.");
    });
    scheduleDaily(2400, () => {
      revealDailyRow("review-prompt");
      announceDaily("18시 회고와 완료 기록을 보여줍니다.");
    });
    scheduleDaily(2760, () => revealDailyRow("reflection"));
    scheduleDaily(3120, () => {
      revealDailyRow("completion");
      setDailyGarden(true);
    });
    scheduleDaily(3480, () => revealDailyRow("evening-peer"));
    scheduleDaily(3840, () => {
      dailyPlaying = false;
      announceDaily("하루 미리보기를 모두 보여줬습니다.");
    });
  };
  dailyReplay.addEventListener("click", playDailyPreview);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dailyPlaying) return;
    clearDailyPlayback();
    dailyReplay.textContent = "다시 보기";
    announceDaily("재생을 멈췄습니다. 보인 대화는 그대로 읽을 수 있습니다.");
  });
  motionPreference.addEventListener("change", applyDailyMotionPreference);
  applyDailyMotionPreference();
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
