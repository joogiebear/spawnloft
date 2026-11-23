'use strict';
  // Electron supplies the saved preference before this file paints. Only the two known names
  // reach the attribute; opening setup.html by itself keeps the original Classic appearance.
  document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'spawnloft' ? 'spawnloft' : 'classic';
