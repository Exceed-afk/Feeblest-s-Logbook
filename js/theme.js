/* Theme: light by default, dark through <html data-theme="dark">.
   Loaded in <head> so the right theme is set before the page first paints.
   A saved choice wins; otherwise the system setting decides. */
(function () {
  'use strict';

  const KEY = 'logbook.theme';
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function updateButton() {
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = current() === 'dark' ? 'Light mode' : 'Dark mode';
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    updateButton();
  }

  apply(saved() || (media && media.matches ? 'dark' : 'light'));

  if (media && media.addEventListener) {
    media.addEventListener('change', function (e) {
      if (!saved()) apply(e.matches ? 'dark' : 'light');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    updateButton();
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const next = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (err) { /* the choice just won't be remembered */ }
      apply(next);
    });
  });
})();
