
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  initSmoothScrolling();
  initCurrentYear();
});

function initNavigation() {
  const menuButton = document.getElementById("menu-button");
  const siteMenu = document.getElementById("site-menu");
  const backdrop = document.getElementById("menu-backdrop");

  if (!menuButton || !siteMenu || !backdrop) {
    console.warn("Kivo navigation elements were not found.");
    return;
  }

  function openMenu() {
    siteMenu.hidden = false;
    backdrop.hidden = false;

    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Close navigation menu");

    document.body.classList.add("menu-open");
  }

  function closeMenu() {
    siteMenu.hidden = true;
    backdrop.hidden = true;

    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation menu");

    document.body.classList.remove("menu-open");
  }

  menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";

    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  backdrop.addEventListener("click", closeMenu);

  siteMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeMenu);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
    }
  });

  closeMenu();
}

function initSmoothScrolling() {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href");

      if (!targetId || targetId === "#") {
        return;
      }

      const target = document.querySelector(targetId);

      if (!target) {
        return;
      }

      event.preventDefault();

      target.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });

      if (window.location.hash !== targetId) {
        history.replaceState(null, "", targetId);
      }
    });
  });
}

function initCurrentYear() {
  const yearElement = document.getElementById("current-year");

  if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
  }
}
