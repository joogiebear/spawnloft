'use strict';
  // The panel serves this page with the saved theme already in <html data-theme>; ?theme= still
  // overrides it, for screenshots.
  const themeAsked = new URLSearchParams(location.search).get('theme')
  if (themeAsked) document.documentElement.dataset.theme = themeAsked === 'spawnloft' ? 'spawnloft' : 'classic'
  // inside the panel's Play page (a frame of the panel's own origin): the top bar is a page head,
  // set before the first paint so the brand never shows (the body script reads this as EMBEDDED)
  if (window.self !== window.top) document.documentElement.dataset.embedded = ''
