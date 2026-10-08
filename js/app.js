/* =========================================
   KIVO — APP.JS
   ========================================= */

document.addEventListener("DOMContentLoaded", () => {
  initMobileMenu();
  initSmoothScrolling();
  initButtonStates();
});

/* =========================================
   MOBILE MENU
   ========================================= */

function initMobileMenu() {
  const menuToggle = document.querySelector(".menu-toggle");
  const mobileMenu = document.querySelector(".mobile-menu");

  if (!menuToggle || !mobileMenu) return;

  menuToggle.addEventListener("click", () => {
    const isOpen = mobileMenu.classList.toggle("is-open");

    menuToggle.setAttribute("aria-expanded", String(isOpen));

    mobileMenu.style.display = isOpen ? "block" : "none";
  });
}

/* =========================================
   SMOOTH SCROLLING
   ========================================= */

function initSmoothScrolling() {
  const links = document.querySelectorAll('a[href^="#"]');

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href");

      if (!targetId || targetId === "#") return;

      const target = document.querySelector(targetId);

      if (!target) return;

      event.preventDefault();

      target.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  });
}

/* =========================================
   BUTTON INTERACTIONS
   ========================================= */

function initButtonStates() {
  const buttons = document.querySelectorAll("[data-action]");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;

      if (!action) return;

      if (action === "login") {
        console.log("Login action triggered.");
      }

      if (action === "signup") {
        console.log("Signup action triggered.");
      }
    });
  });
}
