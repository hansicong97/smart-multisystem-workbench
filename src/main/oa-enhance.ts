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

// ---------------------------------------------------------------------------
// Meal allowance (误餐补贴) batch fill.
//
// The pure planning logic below is written in plain ES5 style with no module
// references so the compiled function source can be embedded into the injected
// main-world script via toString() (single source of truth) AND unit-tested
// directly from dist. The DOM/panel logic lives in MEAL_FILL_SCRIPT and follows
// the same injection contract as the city swap: main-world, idempotent, no IPC.
// ---------------------------------------------------------------------------

export interface MealPerson { id: string; name: string; org: string }
export interface MealTask {
  date: string; type: string; personId: string; personName: string; org: string; note: string;
}
export interface MealPlanConfig {
  start: string; end: string; skipWeekend: boolean; skipText: string; noteText: string;
  entries: string[]; people: MealPerson[]; amountHint?: Record<string, number>;
}
export interface MealPlan {
  tasks: MealTask[]; days: number; rows: number; sum: number; first: string; last: string;
  byPerson: { id: string; name: string; org: string; days: number; rows: number; sum: number }[];
}
export interface MealRowDescriptor {
  date: string; type: string; personId: string; personName: string; org: string; empty: boolean;
}
export interface MealFillDiff {
  fillTasks: MealTask[]; matchedCount: number; emptyCount: number; needNew: number;
  conflicts: MealRowDescriptor[];
}

// Expand the date range, drop weekends/skipped days, attach notes, then emit
// tasks in person-major order (finish one person's dates before the next).
export function buildMealPlan(cfg: MealPlanConfig): MealPlan {
  function pad(n: number) { return (n < 10 ? '0' : '') + n; }
  function ymd(d: Date) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s: string) { var p = String(s).trim().split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d: Date, n: number) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function expandSpec(text: string) {
    var out: string[] = []; var seen: Record<string, number> = {};
    String(text || '').split(/[\n,，、;；]/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === '#') return;
      var m = line.match(/^(\d{4}-\d{2}-\d{2})\s*[~～至到-]+\s*(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        var a = parseYmd(m[1]); var b = parseYmd(m[2]);
        for (var d = new Date(a.getTime()); d <= b; d = addDays(d, 1)) {
          var k = ymd(d); if (!seen[k]) { seen[k] = 1; out.push(k); }
        }
        return;
      }
      m = line.match(/^(\d{4}-\d{2}-\d{2})$/);
      if (m && !seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); }
    });
    return out;
  }
  function expandNotes(text: string) {
    var map: Record<string, string> = {};
    String(text || '').split('\n').forEach(function (line) {
      var m = line.match(/^(.+?)[=＝]\s*(.+)$/);
      if (!m) return;
      var note = m[2].trim();
      expandSpec(m[1]).forEach(function (k) { map[k] = note; });
    });
    return map;
  }
  var hint = cfg.amountHint || { '夜宵补贴': 15, '误正餐补贴': 25 };
  var entries = cfg.entries || [];
  var people = cfg.people || [];
  if (!entries.length) throw new Error('至少勾选一种补贴类型');
  if (!people.length) throw new Error('至少选择一名用餐人员');
  var start = parseYmd(cfg.start); var end = parseYmd(cfg.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('请填写有效的起止日期');
  if (end < start) throw new Error('结束日期早于开始日期');
  var skip: Record<string, number> = {};
  expandSpec(cfg.skipText).forEach(function (k) { skip[k] = 1; });
  var notes = expandNotes(cfg.noteText);
  var dates: { date: string; note: string }[] = [];
  for (var d = new Date(start.getTime()); d <= end; d = addDays(d, 1)) {
    var k = ymd(d);
    if (cfg.skipWeekend && (d.getDay() === 0 || d.getDay() === 6)) continue;
    if (skip[k]) continue;
    dates.push({ date: k, note: notes[k] || '' });
  }
  if (!dates.length) throw new Error('这个区间里没有要填的日期');
  var tasks: MealTask[] = [];
  var byPerson: MealPlan['byPerson'] = [];
  people.forEach(function (p) {
    var rows = 0; var sum = 0;
    dates.forEach(function (day) {
      entries.forEach(function (t) {
        tasks.push({ date: day.date, type: t, personId: p.id, personName: p.name, org: p.org, note: day.note });
        rows += 1; sum += (hint[t] || 0);
      });
    });
    byPerson.push({ id: p.id, name: p.name, org: p.org, days: dates.length, rows: rows, sum: sum });
  });
  var totalSum = 0; byPerson.forEach(function (b) { totalSum += b.sum; });
  return {
    tasks: tasks, days: dates.length, rows: tasks.length, sum: totalSum,
    first: dates[0].date, last: dates[dates.length - 1].date, byPerson: byPerson,
  };
}

// Resume diff: match existing non-empty rows against planned tasks by
// (date,type,personId,org). Matched rows are left in place; only missing tasks
// are filled (into empty rows first, then newly added ones). Non-matching
// filled rows are reported as conflicts and never touched here.
export function diffMealFill(existing: MealRowDescriptor[], tasks: MealTask[]): MealFillDiff {
  function key(r: { date: string; type: string; personId: string; org: string }) {
    return r.date + '|' + r.type + '|' + r.personId + '|' + r.org;
  }
  var planned: Record<string, number> = {};
  tasks.forEach(function (t) { planned[key(t)] = 1; });
  var matched: Record<string, number> = {};
  var emptyCount = 0;
  var conflicts: MealRowDescriptor[] = [];
  existing.forEach(function (r) {
    if (r.empty) { emptyCount += 1; return; }
    var k = key(r);
    if (planned[k]) matched[k] = 1;
    else conflicts.push(r);
  });
  var fillTasks = tasks.filter(function (t) { return !matched[key(t)]; });
  var needNew = Math.max(0, fillTasks.length - emptyCount);
  return {
    fillTasks: fillTasks, matchedCount: tasks.length - fillTasks.length,
    emptyCount: emptyCount, needNew: needNew, conflicts: conflicts,
  };
}

export const MEAL_FILL_SCRIPT = '(function () {\n'
  + 'var buildMealPlan = ' + buildMealPlan.toString() + ';\n'
  + 'var diffMealFill = ' + diffMealFill.toString() + ';\n'
  + String.raw`
  if (window.__smswMealFill) return;
  window.__smswMealFill = true;
  var DOC = document;
  var WIN = window;
  var LS_KEY = '__smswMealPeople';
  var PANEL_ID = '__smswMealPanel';
  var TOGGLE_ID = '__smswMealToggle';
  var roster = [];
  var panel = null;

  function jq() { return WIN.jQuery || WIN.$; }
  function findTable() {
    var tables = DOC.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i].innerText || '';
      if (t.indexOf('申请日期') > -1 && t.indexOf('补贴类型') > -1 && t.indexOf('用餐人员编制') > -1) return tables[i];
    }
    return null;
  }
  function readHeader(table) {
    var trs = table.querySelectorAll('tr');
    var headerIdx = -1, cells = null;
    for (var i = 0; i < trs.length; i++) {
      var txt = trs[i].innerText || '';
      if (txt.indexOf('申请日期') > -1 && txt.indexOf('序号') > -1) { headerIdx = i; cells = trs[i].querySelectorAll('td,th'); break; }
    }
    if (headerIdx < 0) throw new Error('没找到明细表头（申请日期那一行）');
    var idx = {};
    for (var c = 0; c < cells.length; c++) {
      var h = (cells[c].innerText || '').replace(/\s+/g, '');
      if (/^序号/.test(h)) idx.no = c;
      else if (/^申请日期/.test(h)) idx.date = c;
      else if (/^补贴类型/.test(h)) idx.type = c;
      else if (/^用餐人员编制/.test(h)) idx['编制'] = c;
      else if (/A编/.test(h)) idx.a = c;
      else if (/B编/.test(h)) idx.b = c;
      else if (/^补贴金额/.test(h)) idx.amount = c;
      else if (/^当日已补贴次数来源/.test(h)) idx.src = c;
      else if (/^当日已补贴次数/.test(h)) idx.cnt = c;
      else if (/^备注/.test(h)) idx.note = c;
    }
    return { headerIdx: headerIdx, cellCount: cells.length, idx: idx };
  }
  function getRows(table, h) {
    var trs = table.querySelectorAll('tr');
    var out = [];
    for (var i = h.headerIdx + 1; i < trs.length; i++) {
      var tr = trs[i];
      if (tr.querySelectorAll('td').length !== h.cellCount) continue;
      if (!tr.querySelector('select')) continue;
      out.push(tr);
    }
    return out;
  }
  function memberVal(v) {
    var s = String(v == null ? '' : v).trim();
    var m = /^Member\|(\d+)$/.exec(s);
    if (m) return m[1];
    return /^\d{5,}$/.test(s) ? s : null;
  }
  function readApplicant() {
    var name = '';
    var sp = DOC.getElementById('field0003');
    if (sp) name = (sp.innerText || sp.textContent || '').trim();
    var id = null;
    var wins = [WIN];
    try { if (WIN.parent && WIN.parent !== WIN) wins.push(WIN.parent); } catch (e) {}
    try { if (WIN.top && WIN.top !== WIN) wins.push(WIN.top); } catch (e) {}
    for (var i = 0; i < wins.length; i++) {
      if (id) break;
      try { var u = wins[i].CurrentUserId; if (u) { u = String(u).replace(/\D/g, ''); if (u) id = u; } } catch (e) {}
    }
    return (id && name) ? { id: id, name: name, org: 'A编', src: '申请人' } : null;
  }
  function readUndertaker() {
    var h = DOC.getElementById('field0073');
    var t = DOC.getElementById('field0073_txt');
    var id = h ? memberVal(h.value) : null;
    var name = t ? (t.value || '').trim() : '';
    return (id && name) ? { id: id, name: name, org: 'A编', src: '承担人' } : null;
  }
  function readRowPerson(table, h) {
    var rows = getRows(table, h);
    if (!rows.length) return null;
    var cells = rows[0].querySelectorAll('td');
    var cols = [{ idx: h.idx.a, org: 'A编' }, { idx: h.idx.b, org: 'B编' }];
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (c.idx == null) continue;
      var cell = cells[c.idx];
      if (!cell) continue;
      var hid = cell.querySelector('input[type="hidden"]');
      var txt = cell.querySelector('input[type="text"]');
      var id = hid ? memberVal(hid.value) : null;
      var name = txt ? (txt.value || '').trim() : '';
      if (id && name) return { id: id, name: name, org: c.org, src: '表单首行' };
    }
    return null;
  }
  function buildNameCell(aCell) {
    var span = aCell.querySelector('span[id$="_span"]');
    var fieldId = 'field0049';
    if (span && span.id) fieldId = span.id.replace(/_span$/, '');
    else if (aCell.querySelector('span[id]')) fieldId = aCell.querySelector('span[id]').id;
    var disp = '用餐人员';
    var fv0 = span ? (span.getAttribute('fieldval') || '') : '';
    var dm = fv0.match(/displayName:\s*"([^"]*)"/);
    if (dm) disp = dm[1];
    aCell.innerHTML = [
      '<span id="' + fieldId + '_span" class="editableSpan edit_class"',
      ' fieldval=\'{name:"' + fieldId + '",isMasterFiled:"false",displayName:"' + disp + '",',
      'fieldType:"VARCHAR",inputType:"member",formatType:"1",value:""}\'>',
      '<input type="text" onblur="calc(this);" class="xdTextBox validate comp"',
      ' comp="type:&quot;selectPeople&quot;,showOriginalElement:false,selectType:&quot;Member&quot;,',
      'minSize:0,maxSize:1,callback:selectOrgCallBack,valueChange:orgFieldOnChange,',
      'hasRelationField:true,isMasterField:false,fieldName:&quot;' + fieldId + '&quot;"',
      ' unique="false" name="' + fieldId + '_txt" id="' + fieldId + '_txt"',
      ' validate=\'name:"' + disp + '",type:"string",notNull:true\' readonly="readonly"',
      ' comptype="selectPeople" _inited="1">',
      '<input type="hidden" id="' + fieldId + '" name="' + fieldId + '">',
      '<span _isrel="1" class="ico16 radio_people_16 _autoBtn"></span>',
      '</span>'
    ].join('');
    return aCell;
  }
  function ensureNameCell(tr, cellIdx) {
    if (cellIdx == null) throw new Error('明细表里没有这一列');
    var cells = tr.querySelectorAll('td');
    var aCell = cells[cellIdx];
    if (!aCell) throw new Error('明细行里找不到姓名格');
    if (!aCell.querySelector('input[id$="_txt"]')) buildNameCell(aCell);
    return aCell;
  }
  function optionValue(sel, label) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].text.trim() === label) return sel.options[i].value;
    }
    return null;
  }
  function fillRow(tr, h, task) {
    var $ = jq();
    var cells = tr.querySelectorAll('td');
    var idx = h.idx;
    var dt = cells[idx.date].querySelector('input[type="text"]');
    if (!dt) throw new Error('日期格没有输入框');
    $(dt).val(task.date);
    try { WIN.calc(dt); } catch (e) {}
    var selT = cells[idx.type].querySelector('select');
    var txtT = cells[idx.type].querySelector('input[id$="_txt"]');
    if (selT) {
      var vt = optionValue(selT, task.type);
      if (vt === null) throw new Error('补贴类型下拉里没有「' + task.type + '」');
      $(selT).val(vt);
      if (txtT) txtT.value = task.type;
    }
    var selB = cells[idx['编制']].querySelector('select');
    var txtB = cells[idx['编制']].querySelector('input[id$="_txt"]');
    if (selB) {
      var vb = optionValue(selB, task.org);
      if (vb === null) throw new Error('编制下拉里没有「' + task.org + '」');
      $(selB).val(vb);
      if (txtB) txtB.value = task.org;
    }
    var aCell = ensureNameCell(tr, task.org === 'B编' ? idx.b : idx.a);
    var v = 'Member|' + task.personId;
    var hid = aCell.querySelector('input[type="hidden"]');
    var txt = aCell.querySelector('input[type="text"]');
    if (hid) hid.value = v;
    if (txt) txt.value = task.personName;
    var span = aCell.querySelector('span[id$="_span"]');
    if (span) {
      var fv = span.getAttribute('fieldval') || '';
      span.setAttribute('fieldval', fv.replace(/value:"[^"]*"/, 'value:"' + v + '"'));
    }
    if (idx.note != null && task.note) {
      var note = cells[idx.note].querySelector('input[type="text"]');
      if (note) note.value = task.note;
    }
  }
  function fireChange(tr, h) {
    var $ = jq();
    var cells = tr.querySelectorAll('td');
    [h.idx.date, h.idx.type, h.idx['编制']].forEach(function (i) {
      if (i == null) return;
      var td = cells[i];
      if (!td) return;
      var el = td.querySelector('select') || td.querySelector('input[type="text"]');
      if (!el) return;
      try { $(el).trigger('change'); } catch (e) {}
      var txt = td.querySelector('input[type="text"]');
      if (txt && /252,\s*221,\s*139/.test(txt.getAttribute('style') || '')) txt.style.backgroundColor = '#fff';
    });
  }
  function addRow(table, h) {
    var rows = getRows(table, h);
    var last = rows[rows.length - 1];
    WIN.addEmpty({ data: { currentNode: last } });
  }
  function clearAll(table, h) {
    var rows = getRows(table, h);
    if (!rows.length) return;
    if (WIN.validateRepeatRow && !WIN.validateRepeatRow(jq()(rows[0]))) throw new Error('当前行有未填完的必填项，无法清空');
    rows[0].click();
    var btn = DOC.getElementById('delAllImg');
    if (!btn) throw new Error('找不到「删除全部」按钮');
    btn.click();
  }
  function rowDescriptor(tr, h) {
    var cells = tr.querySelectorAll('td');
    var dateEl = cells[h.idx.date] && cells[h.idx.date].querySelector('input[type="text"]');
    var date = dateEl ? (dateEl.value || '').trim() : '';
    var typeSel = cells[h.idx.type] && cells[h.idx.type].querySelector('select');
    var type = typeSel ? ((typeSel.options[typeSel.selectedIndex] || {}).text || '').trim() : '';
    if (type === '请选择') type = '';
    var orgSel = cells[h.idx['编制']] && cells[h.idx['编制']].querySelector('select');
    var org = orgSel ? ((orgSel.options[orgSel.selectedIndex] || {}).text || '').trim() : '';
    if (org === '请选择') org = '';
    var personId = '', personName = '';
    [{ idx: h.idx.a }, { idx: h.idx.b }].forEach(function (c) {
      if (personId || c.idx == null) return;
      var cell = cells[c.idx];
      if (!cell) return;
      var hid = cell.querySelector('input[type="hidden"]');
      var txt = cell.querySelector('input[type="text"]');
      var id = hid ? memberVal(hid.value) : null;
      if (id) { personId = id; personName = txt ? (txt.value || '').trim() : ''; }
    });
    return { date: date, type: type, personId: personId, personName: personName, org: org, empty: !date && !personId };
  }
  function readExisting(table, h) {
    return getRows(table, h).map(function (tr) { return rowDescriptor(tr, h); });
  }
  function isEmptyRow(tr, h) { return rowDescriptor(tr, h).empty; }

  // ---- roster persistence ----
  function loadStored() {
    try { var r = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; }
  }
  function saveStored() {
    try {
      var others = roster.filter(function (p) { return !p.isSelf; })
        .sort(function (a, b) { return (b.lastUsed || 0) - (a.lastUsed || 0); }).slice(0, 20);
      localStorage.setItem(LS_KEY, JSON.stringify(others));
    } catch (e) {}
  }
  function findPerson(id) {
    for (var i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i];
    return null;
  }
  function upsertPerson(p, checked) {
    var existing = findPerson(p.id);
    if (existing) {
      existing.name = p.name; existing.org = p.org; existing.lastUsed = Date.now();
      if (checked) existing.checked = true;
      if (p.src === '申请人') existing.isSelf = true;
    } else {
      roster.push({ id: p.id, name: p.name, org: p.org, lastUsed: Date.now(), checked: !!checked, isSelf: p.src === '申请人' });
    }
    sortRoster();
    saveStored();
  }
  function sortRoster() {
    roster.sort(function (a, b) {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    });
  }
  function initRoster() {
    roster = [];
    var self = readApplicant();
    if (self) roster.push({ id: self.id, name: self.name, org: 'A编', lastUsed: Date.now(), checked: true, isSelf: true });
    loadStored().forEach(function (p) {
      if (!p || !p.id || !p.name || findPerson(p.id)) return;
      roster.push({ id: p.id, name: p.name, org: p.org === 'B编' ? 'B编' : 'A编', lastUsed: p.lastUsed || 0, checked: false, isSelf: false });
    });
    sortRoster();
  }

  // ---- panel ----
  function log(msg) {
    var el = panel.querySelector('#__smswMealLog');
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  }
  function updateSummary() {
    var sel = roster.filter(function (p) { return p.checked; });
    var el = panel.querySelector('#__smswMealSummary');
    el.textContent = sel.length ? '已选 ' + sel.length + ' 人：' + sel.map(function (p) { return p.name; }).join('、') : '未选择人员';
    el.style.color = sel.length ? '#22303f' : '#c0392b';
  }
  function renderRoster() {
    var box = panel.querySelector('#__smswMealRoster');
    box.innerHTML = '';
    roster.forEach(function (p) {
      var row = DOC.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0';
      var label = DOC.createElement('label');
      label.style.cssText = 'flex:1;display:flex;align-items:center;gap:4px;overflow:hidden';
      var cb = DOC.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!p.checked; cb.setAttribute('data-check', p.id);
      label.appendChild(cb);
      var nm = DOC.createElement('span');
      nm.textContent = p.name + (p.isSelf ? '（我）' : '');
      nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      label.appendChild(nm);
      row.appendChild(label);
      var org = DOC.createElement('select');
      org.setAttribute('data-org', p.id);
      ['A编', 'B编'].forEach(function (o) {
        var op = DOC.createElement('option'); op.value = o; op.textContent = o;
        if (o === p.org) op.selected = true;
        org.appendChild(op);
      });
      row.appendChild(org);
      if (!p.isSelf) {
        var rm = DOC.createElement('button');
        rm.type = 'button'; rm.textContent = '×'; rm.title = '移除此人';
        rm.setAttribute('data-remove', p.id);
        rm.style.cssText = 'border:none;background:none;color:#c0392b;cursor:pointer;font-size:14px';
        row.appendChild(rm);
      }
      box.appendChild(row);
    });
    updateSummary();
  }
  function readCfg() {
    var entries = [];
    if (panel.querySelector('#__smswMealT1').checked) entries.push('夜宵补贴');
    if (panel.querySelector('#__smswMealT2').checked) entries.push('误正餐补贴');
    var people = roster.filter(function (p) { return p.checked; })
      .map(function (p) { return { id: p.id, name: p.name, org: p.org }; });
    return {
      start: panel.querySelector('#__smswMealStart').value,
      end: panel.querySelector('#__smswMealEnd').value,
      skipWeekend: panel.querySelector('#__smswMealWeekend').checked,
      skipText: panel.querySelector('#__smswMealSkip').value,
      noteText: panel.querySelector('#__smswMealNote').value,
      entries: entries, people: people,
      clearFirst: panel.querySelector('#__smswMealClear').checked,
    };
  }
  function computePending() {
    var cfg = readCfg();
    var plan = buildMealPlan(cfg);
    var table = findTable();
    if (!table) throw new Error('没找到表单，请先打开一张误餐补贴单');
    var h = readHeader(table);
    var diff = diffMealFill(readExisting(table, h), plan.tasks);
    return { cfg: cfg, plan: plan, diff: diff };
  }
  function showConfirm(text) {
    var strip = panel.querySelector('#__smswMealConfirm');
    panel.querySelector('#__smswMealConfirmText').textContent = text;
    strip.style.display = 'block';
  }
  function hideConfirm() { panel.querySelector('#__smswMealConfirm').style.display = 'none'; }

  function ensureRows(table, h, toAdd, done) {
    if (toAdd <= 0) return done();
    var target = getRows(table, h).length + toAdd;
    var guard = 0;
    (function step() {
      var n = getRows(table, h).length;
      if (n >= target) return done();
      if (guard++ > toAdd + 20) return done(new Error('加行失败，当前只有 ' + n + ' 行'));
      addRow(table, h);
      setTimeout(step, 40);
    })();
  }
  function finish(plan, table, filled) {
    var totalEl = DOC.getElementById('field0015');
    var total = totalEl ? (totalEl.innerText || totalEl.textContent || '').trim() : '?';
    plan.byPerson.forEach(function (b) { upsertPerson({ id: b.id, name: b.name, org: b.org, src: '' }, false); });
    saveStored();
    log('完成：本次写入 ' + filled + ' 行，表单合计 ' + total + ' 元（预览估算 ' + plan.sum.toFixed(2) + ' 元）');
    log('请自行核对日期和金额，确认无误后在原网页手动点「发送」。');
  }
  function executeFill() {
    hideConfirm();
    var pending;
    try { pending = computePending(); } catch (e) { log('✗ ' + e.message); return; }
    var cfg = pending.cfg, plan = pending.plan;
    var table = findTable(); var h = readHeader(table);
    try {
      if (cfg.clearFirst) { clearAll(table, h); table = findTable(); h = readHeader(table); }
    } catch (e) { log('✗ 清空失败：' + e.message); return; }
    var diff = diffMealFill(readExisting(table, h), plan.tasks);
    var need = diff.fillTasks.length;
    if (!need) { log('没有需要填入的行（已全部匹配）。'); finish(plan, table, 0); return; }
    if (diff.conflicts.length) log('注意：有 ' + diff.conflicts.length + ' 行内容与本次计划不一致，已保留不动。');
    var toAdd = Math.max(0, need - diff.emptyCount);
    log('准备填入 ' + need + ' 行（跳过已填 ' + diff.matchedCount + ' 行，新增 ' + toAdd + ' 行）…');
    ensureRows(table, h, toAdd, function (err) {
      if (err) { log('✗ ' + err.message); return; }
      var rows = getRows(table, h);
      var emptyRows = rows.filter(function (tr) { return isEmptyRow(tr, h); });
      var filled = 0, failed = [];
      diff.fillTasks.forEach(function (task, i) {
        var tr = emptyRows[i];
        if (!tr) { failed.push((i + 1) + ' 无可用行'); return; }
        try { fillRow(tr, h, task); filled++; } catch (e) { failed.push((i + 1) + ' ' + e.message); }
      });
      log('已写入 ' + filled + ' 行');
      if (failed.length) log('✗ 失败：\n' + failed.join('\n'));
      var k = 0;
      (function tick() {
        if (k >= filled) return finish(plan, table, filled);
        var tr = emptyRows[k];
        if (tr) { try { fireChange(tr, h); } catch (e) {} }
        k++;
        setTimeout(tick, 40);
      })();
    });
  }

  function buildPanel() {
    var old = DOC.getElementById(PANEL_ID);
    if (old) old.parentNode.removeChild(old);
    var now = new Date();
    var defEnd = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var defStart = new Date(defEnd.getFullYear(), defEnd.getMonth(), 1);
    var defEndDay = new Date(defEnd.getFullYear(), defEnd.getMonth() + 1, 0);
    function ymd(d) { return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }

    var box = DOC.createElement('div');
    box.id = PANEL_ID;
    // The panel anchors right above the fixed toggle button (16px margin +
    // 44px button + 12px gap), so expanding/collapsing happens in one corner.
    box.style.cssText = 'position:fixed;right:16px;bottom:72px;z-index:2147483000;width:320px;background:#fff;'
      + 'border:1px solid #c9d2dd;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.18);'
      + 'max-height:calc(100vh - 88px);overflow:auto;'
      + 'font:13px/1.6 Segoe UI,Microsoft YaHei,sans-serif;color:#22303f;padding:12px 14px';
    box.innerHTML = [
      '<div style="display:flex;align-items:center;margin-bottom:8px">',
      '  <b style="flex:1">误餐补贴 · 批量填写</b>',
      '</div>',
      '<div id="__smswMealSummary" style="margin-bottom:6px;padding:5px 6px;background:#f2f7fd;border-radius:4px"></div>',
      '<div style="display:flex;gap:6px;margin-bottom:6px">',
      '  <button id="__smswMealRosterToggle" type="button" style="flex:1;border:1px solid #b9c4d1;background:#fff;border-radius:4px;cursor:pointer;padding:3px 8px">人员 ▾</button>',
      '  <button id="__smswMealReadForm" type="button" title="读取首行姓名格或承担人已选的人" style="border:1px solid #b9c4d1;background:#fff;border-radius:4px;cursor:pointer;padding:3px 8px">读取表单</button>',
      '  <button id="__smswMealOnlyMe" type="button" style="border:1px solid #b9c4d1;background:#fff;border-radius:4px;cursor:pointer;padding:3px 8px">只选我</button>',
      '</div>',
      '<div id="__smswMealRoster" style="display:none;max-height:150px;overflow:auto;border:1px solid #e3e9f0;border-radius:4px;padding:4px 6px;margin-bottom:6px"></div>',
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">',
      '  <span style="width:52px;color:#5a6b7d">区间</span>',
      '  <input id="__smswMealStart" type="date" style="flex:1;min-width:0;padding:3px 4px;border:1px solid #cfd8e3;border-radius:4px">',
      '  <input id="__smswMealEnd" type="date" style="flex:1;min-width:0;padding:3px 4px;border:1px solid #cfd8e3;border-radius:4px">',
      '</div>',
      '<label style="display:block;margin:4px 0"><input id="__smswMealWeekend" type="checkbox" checked> 跳过周六日</label>',
      '<div style="margin:6px 0 2px;color:#5a6b7d">要跳过的日期（可多段，如 2026-10-01~2026-10-07）</div>',
      '<textarea id="__smswMealSkip" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #cfd8e3;border-radius:4px;padding:4px 6px;font:inherit"></textarea>',
      '<div style="margin:6px 0 2px;color:#5a6b7d">加班备注（格式：2026-10-01~2026-10-03 = 国庆加班）</div>',
      '<textarea id="__smswMealNote" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #cfd8e3;border-radius:4px;padding:4px 6px;font:inherit"></textarea>',
      '<div style="margin:8px 0 2px;color:#5a6b7d">每天填这些</div>',
      '<label style="display:inline-block;margin-right:12px"><input id="__smswMealT1" type="checkbox" checked> 夜宵 15</label>',
      '<label style="display:inline-block"><input id="__smswMealT2" type="checkbox" checked> 正餐 25</label>',
      '<label style="display:block;margin-top:6px"><input id="__smswMealClear" type="checkbox"> 填入前清空已有明细</label>',
      '<div style="margin-top:10px;display:flex;gap:8px">',
      '  <button id="__smswMealPreview" type="button" style="padding:5px 12px;border:1px solid #b9c4d1;background:#f5f8fb;border-radius:4px;cursor:pointer">预览</button>',
      '  <button id="__smswMealFill" type="button" style="padding:5px 12px;border:1px solid #2f6fd0;background:#3b7de0;color:#fff;border-radius:4px;cursor:pointer">填入</button>',
      '</div>',
      '<div id="__smswMealConfirm" style="display:none;margin-top:8px;padding:6px 8px;background:#fff7e6;border:1px solid #f0d9a8;border-radius:4px">',
      '  <div id="__smswMealConfirmText" style="margin-bottom:6px"></div>',
      '  <button id="__smswMealConfirmYes" type="button" style="padding:4px 10px;border:1px solid #2f6fd0;background:#3b7de0;color:#fff;border-radius:4px;cursor:pointer">确认填入</button>',
      '  <button id="__smswMealConfirmNo" type="button" style="margin-left:6px;padding:4px 10px;border:1px solid #b9c4d1;background:#fff;border-radius:4px;cursor:pointer">取消</button>',
      '</div>',
      '<div id="__smswMealLog" style="margin-top:8px;max-height:180px;overflow:auto;white-space:pre-wrap;font-size:12px;color:#4a5a6b"></div>'
    ].join('');
    DOC.body.appendChild(box);
    panel = box;
    box.querySelector('#__smswMealStart').value = ymd(defStart);
    box.querySelector('#__smswMealEnd').value = ymd(defEndDay);

    initRoster();
    renderRoster();

    var rosterBox = box.querySelector('#__smswMealRoster');
    box.querySelector('#__smswMealRosterToggle').onclick = function () {
      var open = rosterBox.style.display !== 'none';
      rosterBox.style.display = open ? 'none' : 'block';
      this.textContent = open ? '人员 ▾' : '人员 ▴';
    };
    rosterBox.addEventListener('change', function (ev) {
      var t = ev.target;
      var cid = t.getAttribute && t.getAttribute('data-check');
      var oid = t.getAttribute && t.getAttribute('data-org');
      if (cid) { var p = findPerson(cid); if (p) { p.checked = t.checked; updateSummary(); } }
      else if (oid) { var p2 = findPerson(oid); if (p2) { p2.org = t.value; } }
    });
    rosterBox.addEventListener('click', function (ev) {
      var t = ev.target;
      var rid = t.getAttribute && t.getAttribute('data-remove');
      if (rid) { roster = roster.filter(function (p) { return p.id !== rid; }); saveStored(); renderRoster(); }
    });
    box.querySelector('#__smswMealReadForm').onclick = function () {
      try {
        var table = findTable();
        if (!table) throw new Error('没找到表单，请先打开一张误餐补贴单');
        var h = readHeader(table);
        var p = readRowPerson(table, h) || readUndertaker() || readApplicant();
        if (!p) throw new Error('没读到人员：先用系统选人框在首行姓名格或承担人里选好一个人');
        upsertPerson(p, true);
        renderRoster();
        log('用餐人员 → ' + p.name + '（' + p.src + '，' + p.org + '）');
      } catch (e) { log('✗ ' + e.message); }
    };
    box.querySelector('#__smswMealOnlyMe').onclick = function () {
      var self = null;
      roster.forEach(function (p) { p.checked = false; if (p.isSelf) self = p; });
      if (self) self.checked = true;
      renderRoster();
      log(self ? '已改为只填申请人：' + self.name : '⚠ 未读到申请人，请先「读取表单」选人');
    };
    box.querySelector('#__smswMealPreview').onclick = function () {
      panel.querySelector('#__smswMealLog').textContent = '';
      hideConfirm();
      try {
        var pending = computePending();
        var plan = pending.plan, diff = pending.diff;
        log('共 ' + plan.days + ' 天，' + plan.rows + ' 行，预计合计 ' + plan.sum.toFixed(2) + ' 元');
        log('区间：' + plan.first + ' → ' + plan.last);
        plan.byPerson.forEach(function (b) { log('· ' + b.name + '（' + b.org + '）：' + b.rows + ' 行，' + b.sum.toFixed(2) + ' 元'); });
        log('已填匹配 ' + diff.matchedCount + ' 行，待填 ' + diff.fillTasks.length + ' 行');
        if (diff.conflicts.length) log('⚠ ' + diff.conflicts.length + ' 行内容与计划不一致（保留不动，可勾选清空重来）');
      } catch (e) { log('✗ ' + e.message); }
    };
    box.querySelector('#__smswMealFill').onclick = function () {
      panel.querySelector('#__smswMealLog').textContent = '';
      try {
        var pending = computePending();
        var plan = pending.plan, diff = pending.diff;
        var names = plan.byPerson.map(function (b) { return b.name + '（' + b.org + '）'; }).join('、');
        showConfirm('将为 ' + names + ' 填入 ' + diff.fillTasks.length + ' 行（' + plan.days + ' 天，预计 '
          + plan.sum.toFixed(2) + ' 元，跳过已填 ' + diff.matchedCount + ' 行）。确认？');
      } catch (e) { log('✗ ' + e.message); }
    };
    box.querySelector('#__smswMealConfirmYes').onclick = executeFill;
    box.querySelector('#__smswMealConfirmNo').onclick = hideConfirm;
    buildToggle();
    syncToggle();
  }

  // One fixed button in the bottom-right corner toggles the panel in both
  // directions; it never moves, and the panel opens directly above it.
  function syncToggle() {
    var t = DOC.getElementById(TOGGLE_ID);
    if (!t || !panel) return;
    var open = panel.style.display !== 'none';
    t.textContent = open ? '✕' : '误餐';
    t.title = open ? '收起面板' : '展开误餐补贴批量填写';
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function buildToggle() {
    if (DOC.getElementById(TOGGLE_ID)) return;
    var t = DOC.createElement('div');
    t.id = TOGGLE_ID;
    t.setAttribute('role', 'button');
    t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483001;width:44px;height:44px;'
      + 'border-radius:50%;background:#3b7de0;color:#fff;font:14px/44px Microsoft YaHei,sans-serif;'
      + 'text-align:center;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);user-select:none';
    t.onclick = function () {
      if (!panel) return;
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
      syncToggle();
    };
    DOC.body.appendChild(t);
  }

  function ready() {
    return jq() && typeof WIN.addEmpty === 'function' && findTable();
  }
  function start() { buildPanel(); }
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
