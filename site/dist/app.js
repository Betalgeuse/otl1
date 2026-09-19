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

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("has-motion");
  const revealObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.16 });
  document.querySelectorAll(".reveal").forEach((item) => revealObserver.observe(item));
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
