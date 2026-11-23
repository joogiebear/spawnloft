// The probe checks itself and leaves the answer in the page: the title becomes "probe: pass" or
// "probe: fail", and #result holds one line per check. Whatever drives the browser only has to
// load the page and read those two things, so the same probe runs under any WebDriver.
(function () {
  'use strict'
  var lines = []
  var failed = false
  function check(name, ok, seen) {
    if (!ok) failed = true
    lines.push((ok ? 'ok   ' : 'FAIL ') + name + (seen === undefined ? '' : '  [' + seen + ']'))
  }
  function css(id, prop) { return getComputedStyle(document.getElementById(id)).getPropertyValue(prop).trim() }
  // an engine may write a colour as rgb(), rgba() or color(srgb ...): let the same engine
  // write the expected one too, on a spare element, and compare the two computed values
  var spare = document.createElement('span')
  document.body.appendChild(spare)
  function rgba(colour) {
    spare.style.color = ''
    spare.style.color = colour
    return getComputedStyle(spare).color
  }
  function columns() { return css('grid', 'grid-template-columns').split(' ').filter(Boolean).length }
  var root = document.documentElement

  // a page builds its elements in script and names classes in strings, as the panel does
  var made = document.getElementById('made')
  var row = document.createElement('div')
  row.id = 'row'
  row.className = 'flex items-center gap-2 font-mono text-3 text-warn-ink'
  made.appendChild(row)

  try {
    // 1. the tokens are the theme, and a scheme is still one attribute
    check('classic: card colour', rgba(css('card', 'background-color')) === rgba('#141823'), css('card', 'background-color'))
    check('classic: card corner', css('card', 'border-top-left-radius') === '16px', css('card', 'border-top-left-radius'))
    check('classic: accent', rgba(css('new', 'color')) === rgba('#5b84ff'), css('new', 'color'))
    root.setAttribute('data-theme', 'spawnloft')
    check('spawnloft: card colour', rgba(css('card', 'background-color')) === rgba('#141b15'), css('card', 'background-color'))
    check('spawnloft: card corner', css('card', 'border-top-left-radius') === '12px', css('card', 'border-top-left-radius'))
    check('spawnloft: accent', rgba(css('new', 'color')) === rgba('#c4f566'), css('new', 'color'))
    check('spawnloft: primary button', rgba(css('btn', 'background-color')) === rgba('#c4f566') && rgba(css('btn', 'color')) === rgba('#14200b'), css('btn', 'background-color'))
    root.setAttribute('data-theme', 'classic')

    // 2. spacing, borders and shadows without Tailwind's reset
    check('p-5 is 20px', css('card', 'padding-top') === '20px', css('card', 'padding-top'))
    check('border is one solid pixel', css('card', 'border-top-width') === '1px' && css('card', 'border-top-style') === 'solid', css('card', 'border-top-width') + ' ' + css('card', 'border-top-style'))
    check('shadow-md draws', css('card', 'box-shadow') !== 'none' && css('card', 'box-shadow') !== '', css('card', 'box-shadow'))
    check('h-8 is the 32px hit size', css('btn', 'height') === '32px', css('btn', 'height'))
    check('a transition takes the panel\'s 200ms', css('moves', 'transition-duration').split(',')[0].trim() === '0.2s', css('moves', 'transition-duration'))

    // 3. a see-through colour (color-mix, with a solid fallback before it)
    var wash = rgba(css('wash', 'background-color'))
    check('bg-live/15 is see-through green', wash === rgba('color-mix(in oklab, #4ade80 15%, transparent)') && wash !== rgba('#4ade80') && wash !== rgba('transparent'), wash)

    // 4. the density tiers, as container queries on the pane
    var pane = document.getElementById('pane')
    pane.style.width = '1000px'; check('pane 1000: one column', columns() === 1, columns())
    pane.style.width = '1700px'; check('pane 1700: two columns', columns() === 2, columns())
    pane.style.width = '2560px'; check('pane 2560: three columns', columns() === 3, columns())
    pane.style.width = ''

    // 5. cascade layers: a class from Tailwind beats an old rule with a stronger selector, an
    //    element without one is left alone, and an old !important still holds
    check('old rule alone: its padding', css('old', 'padding-top') === '3px', css('old', 'padding-top'))
    check('old rule alone: its colour', rgba(css('old', 'color')) === rgba('rgb(1, 2, 3)'), css('old', 'color'))
    check('utility over old rule: padding', css('new', 'padding-top') === '16px', css('new', 'padding-top'))
    check('old [hidden] !important over a utility', css('gone', 'display') === 'none', css('gone', 'display'))

    // 6. type roles
    check('type-label: 11px, upper case', css('label', 'font-size') === '11px' && css('label', 'text-transform') === 'uppercase' && css('label', 'font-weight') === '650', css('label', 'font-size') + ' ' + css('label', 'font-weight'))
    check('type-page: 22px', css('title', 'font-size') === '22px', css('title', 'font-size'))

    // 7. classes that only appear in a script string
    check('script-built row: flex', css('row', 'display') === 'flex', css('row', 'display'))
    check('script-built row: 13px', css('row', 'font-size') === '13px', css('row', 'font-size'))
    check('script-built row: warn ink', rgba(css('row', 'color')) === rgba('#f4cd86'), css('row', 'color'))
  } catch (e) {
    check('the probe ran to the end', false, String(e && e.message || e))
  }
  lines.push(navigator.userAgent)
  document.getElementById('result').textContent = lines.join('\n')
  document.title = failed ? 'probe: fail' : 'probe: pass'
})()
