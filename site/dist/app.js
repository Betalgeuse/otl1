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

const previewStates = {
  registration: { time: "10:00", message: "오늘의 한 가지를 적었어요. 첫걸음이 분명해졌네요.", garden: "첫 칸에 씨앗을 심었습니다.", cells: ["filled", "", "", ""], emojis: [["ack-yes.png", "네 이모티콘"], ["blob_smiley.png", "웃는 이모티콘"]] },
  completion: { time: "18:00", message: "오늘의 한 가지를 끝냈네요. 해낸 만큼 쉬어 가요.", garden: "완료한 하루의 잔디가 자랐습니다.", cells: ["filled", "filled", "filled", "filled"], emojis: [["finish_flag.png", "완주 깃발"], ["meow-adorable.png", "고양이 이모티콘"]] },
  rest: { time: "18:00", message: "오늘은 쉬어 가도 괜찮아요. 내일 다시 한 가지에서 시작해요.", garden: "쉬어 간 날도 기록에 남습니다.", cells: ["filled", "rest", "", ""], emojis: [["blob-help.png", "도움 이모티콘"], ["meow-adorable.png", "고양이 이모티콘"]] }
};
const previewButtons = document.querySelectorAll("[data-preview-state]");
const previewMessage = document.querySelector("[data-preview-message]");
const previewTime = document.querySelector("[data-preview-time]");
const previewGarden = document.querySelector("[data-preview-garden]");
const previewCells = document.querySelector("[data-preview-cells]");
const previewReactions = document.querySelector("[data-preview-reactions]");
const previewAnnouncement = document.querySelector("[data-preview-announcement]");
for (const button of previewButtons) button.addEventListener("click", () => {
  const state = previewStates[button.dataset.previewState];
  if (!state || !previewMessage || !previewTime || !previewGarden || !previewCells || !previewReactions || !previewAnnouncement) return;
  for (const option of previewButtons) option.setAttribute("aria-pressed", String(option === button));
  previewMessage.textContent = state.message;
  previewTime.textContent = state.time;
  previewGarden.textContent = state.garden;
  previewCells.replaceChildren(...state.cells.map((value) => {
    const cell = document.createElement("i");
    if (value) cell.className = `is-${value}`;
    return cell;
  }));
  previewReactions.replaceChildren(...state.emojis.map(([filename, label]) => {
    const wrapper = document.createElement("span");
    const image = document.createElement("img");
    image.src = `/assets/otl1-emoji/${filename}`;
    image.width = 128;
    image.height = 128;
    image.alt = label;
    wrapper.append(image);
    return wrapper;
  }));
  previewAnnouncement.textContent = `${button.textContent.trim()}: ${state.message} ${state.garden}`;
});

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
