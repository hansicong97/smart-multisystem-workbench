import type { SiteId } from '../shared/workbench.js';

// Seeyon CAP4 renders the form body in a same-origin frame served by content.do.
// Enhancements are injected into that frame's main world (where the CAP4 globals
// live) by the main process; the remote page keeps its sandbox and gains no IPC.
const OA_FORM_PATH = '/seeyon/content/content.do';

export function isOaFormFrame(siteId: SiteId, address: string): boolean {
  if (siteId !== 'oa') return false;
  const url = URL.parse(address);
  return url?.pathname === OA_FORM_PATH && url.searchParams.get('method') === 'index';
}

// City swap for round-trip travel forms. CAP4 stores a data-relation field's
// canonical value in the `fieldval` JSON on its outer span (getFields() reads
// exactly that), the display text in the inner span, and the linked flag on the
// picker icon. Swapping two such fields means exchanging those value-bearing
// parts while keeping each field's identity (name/id/displayName/relation config)
// in place. Pairs are detected by displayName so no template-specific ids are
// hardcoded here, and buttons only appear on editable rows (picker icon present).
export const CITY_SWAP_SCRIPT = String.raw`
(function () {
  if (window.__smswCitySwap) return;
  window.__smswCitySwap = true;
  var ORIGIN = '出发地';
  var DEST = '目的地';
  var STYLE_ID = 'smsw-city-swap-style';

  function parseFV(raw) {
    try { return window.$.parseJSON(raw); } catch (e) { return null; }
  }
  function findPairs() {
    var pairs = [];
    var grids = document.querySelectorAll('table.xdRepeatingTable');
    Array.prototype.forEach.call(grids, function (grid) {
      var origin = null;
      var dest = null;
      Array.prototype.forEach.call(grid.querySelectorAll('span[fieldval]'), function (span) {
        var fv = parseFV(span.getAttribute('fieldval'));
        if (!fv || fv.toRelationType !== 'form_relation_field') return;
        var label = fv.displayName || '';
        if (!origin && label.indexOf(ORIGIN) >= 0) origin = fv.name;
        if (!dest && label.indexOf(DEST) >= 0) dest = fv.name;
      });
      if (origin && dest) pairs.push({ grid: grid, origin: origin, dest: dest });
    });
    return pairs;
  }
  function dataRows(grid) {
    return Array.prototype.filter.call(grid.querySelectorAll('tr'), function (row) {
      return row.querySelector('span[id$="_span"][fieldval]');
    });
  }
  function parts(row, name) {
    var span = row.querySelector('[id="' + name + '_span"]');
    return {
      span: span,
      inner: row.querySelector('[id="' + name + '"]') || (span ? span.querySelector('.xdRichTextBox') : null),
      icon: row.querySelector('span.correlation_form_16[name="' + name + '"]')
    };
  }
  function swapRow(row, originName, destName) {
    var a = parts(row, originName);
    var b = parts(row, destName);
    if (!a.span || !b.span || !a.inner || !b.inner) return;
    var fva = parseFV(a.span.getAttribute('fieldval'));
    var fvb = parseFV(b.span.getAttribute('fieldval'));
    if (!fva || !fvb) return;
    var va = fva.value;
    var vb = fvb.value;
    var ha = a.inner.innerHTML;
    var hb = b.inner.innerHTML;
    var ra = a.icon ? a.icon.getAttribute('hasrelatied') : null;
    var rb = b.icon ? b.icon.getAttribute('hasrelatied') : null;
    fva.value = vb;
    fvb.value = va;
    a.span.setAttribute('fieldval', JSON.stringify(fva));
    b.span.setAttribute('fieldval', JSON.stringify(fvb));
    a.inner.innerHTML = hb;
    b.inner.innerHTML = ha;
    if (a.icon && rb != null) a.icon.setAttribute('hasrelatied', rb);
    if (b.icon && ra != null) b.icon.setAttribute('hasrelatied', ra);
    if (window.$ && window.$.ctp) window.$.ctp.trigger('afterFormFieldCalc', {});
    if (typeof window.setBGColor === 'function' && window._mainBodyDiv) window.setBGColor(window._mainBodyDiv);
  }
  function makeButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'smsw-city-swap';
    btn.setAttribute('data-smsw-swap', '1');
    btn.title = '互换出发地与目的地';
    btn.setAttribute('aria-label', '互换出发地与目的地');
    btn.textContent = '⇄';
    return btn;
  }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.smsw-city-swap{position:absolute;top:50%;right:-10px;transform:translateY(-50%);z-index:9;'
      + 'box-sizing:border-box;width:20px;height:20px;padding:0;cursor:pointer;font-size:12px;line-height:18px;text-align:center;'
      + 'color:#909399;background:#fff;border:1px solid #c0c4cc;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.08);}'
      + '.smsw-city-swap:hover{color:#409eff;border-color:#409eff;}';
    (document.head || document.documentElement).appendChild(style);
  }
  function decorate() {
    var pairs = findPairs();
    if (!pairs.length) return;
    ensureStyle();
    pairs.forEach(function (pair) {
      dataRows(pair.grid).forEach(function (row) {
        if (row.querySelector('[data-smsw-swap]')) return;
        var a = parts(row, pair.origin);
        if (!a.span || !a.icon) return;
        // Straddle the border between the origin and destination cells: anchor
        // the button to the origin td's right edge, vertically centered.
        var cell = a.span.closest('td');
        if (!cell) return;
        if (window.getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
        cell.appendChild(makeButton());
      });
    });
  }
  function ready() {
    return window.$ && typeof window.$.parseJSON === 'function'
      && document.querySelector('table.xdRepeatingTable');
  }
  function start() {
    // CAP4's left-side row add clones the current row's DOM client-side, which
    // copies our button markup but NOT its listeners. Delegate clicks at the
    // document level and resolve the row/pair at click time so cloned buttons
    // (and rows re-rendered after injection) keep working.
    document.addEventListener('click', function (ev) {
      var target = ev.target;
      if (!target || target.nodeType !== 1) return;
      var btn = target.closest('[data-smsw-swap]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      var row = btn.closest('tr');
      var grid = btn.closest('table.xdRepeatingTable');
      if (!row || !grid) return;
      var pair = findPairs().filter(function (p) { return p.grid === grid; })[0];
      if (pair) swapRow(row, pair.origin, pair.dest);
    }, true);
    decorate();
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; decorate(); }, 50);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (ready()) {
    start();
  } else {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (ready()) { clearInterval(timer); start(); }
      else if (tries > 100) clearInterval(timer);
    }, 100);
  }
})();
`;
