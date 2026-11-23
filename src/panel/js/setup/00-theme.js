'use strict';
  // The panel puts the saved theme in place of the question below when it serves this file. Only
  // the two known names reach the attribute; anything else is the default SpawnLoft look.
  document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'classic' ? 'classic' : 'spawnloft';
