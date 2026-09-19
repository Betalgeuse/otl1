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
