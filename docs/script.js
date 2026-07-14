/* Potatofy marketing site - minimal JS.
   Three small jobs: copy-clone-command, scroll-reveal, smooth in-page nav. */

(() => {
  // A sandboxed iframe without allow-top-navigation throws a SecurityError on
  // this write; without the try/catch, that exception aborted the whole
  // script — including the copy button, scroll reveal, and smooth nav below.
  try {
    if (window.top !== window.self) { window.top.location = window.self.location; }
  } catch (e) {
    console.warn("Frame-busting blocked:", e);
  }

  const prefersReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // -------- Copy clone command --------
  const copyBtn = document.getElementById("copy-btn");
  const cloneCmd = document.getElementById("clone-cmd");

  if (copyBtn && cloneCmd) {
    copyBtn.addEventListener("click", async () => {
      // A second click while still showing "Copied" would otherwise cache
      // "Copied" itself as `old`, so the pending timeout later restored the
      // label to "Copied" instead of the real original text — stuck until reload.
      if (copyBtn.classList.contains("copied")) return;
      const text = cloneCmd.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // execCommand('copy') is deprecated; clipboard API unavailable in this context — silent no-op.
      }
      const old = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = old;
        copyBtn.classList.remove("copied");
      }, 1600);
    });
  }

  // -------- Scroll reveal (IntersectionObserver) --------
  if (!prefersReduce && "IntersectionObserver" in window) {
    const targets = document.querySelectorAll(
      ".hero-copy, .hero-mock, .numbers-wrap, .section-head, .card, .bars, .step, .faq-list, .foot-grid"
    );
    targets.forEach((el) => el.classList.add("reveal"));

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });

    targets.forEach((el) => io.observe(el));
  }

  // -------- Smooth in-page nav --------
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (!id || id === "#" || id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({
        behavior: prefersReduce ? "auto" : "smooth",
        block: "start"
      });
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  });
})();
