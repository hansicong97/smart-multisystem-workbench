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

// The assistant plans and compares meal rows in the main process. Only the
// CAP4 form adapter below runs in the OA frame.

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

// CAP4 adapter evaluated by the main process in a matched OA frame.
// Only the table and the existing origin-local roster are accessed here.
const MEAL_FORM = String.raw`async function (operation) {
  var DOC = document;
  var WIN = window;
  var LS_KEY = '__smswMealPeople';
  function jq() { return WIN.jQuery || WIN.$; }
  function findTable() {
    var matches = [];
    DOC.querySelectorAll('table').forEach(function (table) {
      Array.from(table.rows).forEach(function (row) {
        var idx = {};
        Array.from(row.cells).forEach(function (cell, i) {
          var label = (cell.textContent || '').replace(/\s+/g, '');
          if (/^序号/.test(label)) idx.no = i;
          else if (/^申请日期/.test(label)) idx.date = i;
          else if (/^补贴类型/.test(label)) idx.type = i;
          else if (/^用餐人员编制/.test(label)) idx['编制'] = i;
          else if (/A编/.test(label)) idx.a = i;
          else if (/B编/.test(label)) idx.b = i;
          else if (/^补贴金额/.test(label)) idx.amount = i;
          else if (/^备注/.test(label)) idx.note = i;
        });
        if (['no', 'date', 'type', '编制', 'a', 'b', 'amount'].every(function (key) { return key in idx; })) {
          matches.push({ table: table, headerIdx: row.rowIndex, cellCount: row.cells.length, idx: idx });
        }
      });
    });
    return matches.length === 1 ? matches[0] : null;
  }
  function getRows(table, h) {
    return Array.from(table.rows).slice(h.headerIdx + 1).filter(function (row) {
      return row.cells.length === h.cellCount && !!row.querySelector('select');
    });
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
  function buildNameCell(aCell) {
    var span = aCell.querySelector('span[id$="_span"]');
    var fieldId = 'field0049';
    if (span && span.id) fieldId = span.id.replace(/_span$/, '');
    else if (aCell.querySelector('span[id]')) fieldId = aCell.querySelector('span[id]').id;
    if (!/^field\d+$/.test(fieldId)) throw new Error('未识别到人员字段');
    var disp = '用餐人员';
    var fv0 = span ? (span.getAttribute('fieldval') || '') : '';
    var dm = fv0.match(/displayName:\s*"([^"]*)"/);
    if (dm && !/[<>&'"\r\n]/.test(dm[1])) disp = dm[1];
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
    if (!dt || dt.readOnly || dt.disabled) throw new Error('日期格没有输入框');
    var selT = cells[idx.type].querySelector('select');
    var txtT = cells[idx.type].querySelector('input[id$="_txt"]');
    var vt = selT && !selT.disabled ? optionValue(selT, task.type) : null;
    if (vt === null) throw new Error('补贴类型下拉里没有「' + task.type + '」');
    var selB = cells[idx['编制']].querySelector('select');
    var txtB = cells[idx['编制']].querySelector('input[id$="_txt"]');
    var vb = selB && !selB.disabled ? optionValue(selB, task.org) : null;
    if (vb === null) throw new Error('编制下拉里没有「' + task.org + '」');
    var note = idx.note == null ? null : cells[idx.note].querySelector('input[type="text"],textarea');
    if (task.note && (!note || note.readOnly || note.disabled)) throw new Error('该行备注不可编辑');
    var aCell = ensureNameCell(tr, task.org === 'B编' ? idx.b : idx.a);
    $(dt).val(task.date);
    try { WIN.calc(dt); } catch (e) {}
    $(selT).val(vt);
    if (txtT) txtT.value = task.type;
    $(selB).val(vb);
    if (txtB) txtB.value = task.org;
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
    if (note && task.note) note.value = task.note;
  }
  function fireChange(tr, h) {
    var $ = jq();
    var cells = tr.querySelectorAll('td');
    [h.idx.date, h.idx.type, h.idx['编制'], h.idx.note].forEach(function (i) {
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

  function personAt(row, idx, org) {
    var cell = row.cells[idx];
    var id = memberVal(cell.querySelector('input[type=hidden]')?.value);
    var name = (cell.querySelector('input[id$="_txt"]')?.value || '').trim();
    return id && name ? { id: id, name: name, org: org } : null;
  }
  function readRow(row, h) {
    var idx = h.idx, cells = row.cells;
    var date = (cells[idx.date].querySelector('input[type=text]')?.value || '').trim();
    var type = selected(cells[idx.type]);
    var org = selected(cells[idx['编制']]);
    var people = [personAt(row, idx.a, 'A编'), personAt(row, idx.b, 'B编')].filter(Boolean);
    var who = people.find(function (person) { return person.org === org; }) || people[0];
    var note = idx.note == null ? '' : (cells[idx.note].querySelector('input,textarea')?.value || '').trim();
    var amount = (cells[idx.amount].querySelector('input:not([type=hidden])')?.value || cells[idx.amount].textContent || '').trim();
    var controls = Array.from(row.querySelectorAll('input,select,textarea,[fieldval]')).map(function (element) {
      return [element.id, element.value || '', element.getAttribute('fieldval') || ''];
    });
    // A half-filled row belongs to the user, even if its date is blank.
    var namePresent = [idx.a, idx.b].some(function (i) {
      return Array.from(cells[i].querySelectorAll('input')).some(function (field) { return !!field.value; }) ||
        !!(cells[i].querySelector('.xdRichTextBox')?.textContent || '').trim();
    });
    return {
      date: date, type: type, personId: who?.id || '', personName: who?.name || '', org: org,
      empty: !date && !type && !org && !namePresent && !note && Number(amount.replace(/[,¥￥元\s]/g, '')) === 0,
      note: note, amount: amount, controls: JSON.stringify(controls),
    };
  }
  function selected(cell) {
    var select = cell.querySelector('select');
    var label = (select?.selectedOptions[0]?.text || '').trim();
    return select?.value && label !== '请选择' ? label : '';
  }
  function identity(h) {
    if (!h || !h.table.isConnected) return null;
    var self = readApplicant();
    if (!self) return null;
    var docId = DOC.querySelector('[data-meal-document]')?.getAttribute('data-meal-document') || '';
    if (!docId) {
      var number = Array.from(DOC.querySelectorAll('td')).find(function (cell) {
        return (cell.textContent || '').trim() === '单据编号';
      })?.nextElementSibling;
      docId = (number?.querySelector('input')?.value || number?.textContent || '').trim();
    }
    if (['0', '-1', '-', '—'].includes(docId)) docId = '';
    if (!docId) {
      var urls = [location.href];
      try { urls.push(WIN.top.location.href); } catch (e) {}
      docId = urls.map(function (href) {
        var params = new URL(href).searchParams;
        return params.get('summaryId') || params.get('affairId');
      }).find(function (id) { return id && id !== '0' && id !== '-1'; }) || '';
    }
    var instances = WIN.__smswMealForms;
    if (!instances) instances = WIN.__smswMealForms = new WeakMap();
    if (!instances.has(h.table)) instances.set(h.table, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    return { instance: instances.get(h.table), account: self.name, accountKey: self.id, document: docId || '误餐补贴单', documentId: docId };
  }
  function snapshot(h) {
    var id = identity(h);
    if (!id) return null;
    return {
      ...id, total: (DOC.getElementById('field0015')?.textContent || '').trim(),
      rows: getRows(h.table, h).map(function (row) { return readRow(row, h); }),
    };
  }
  function getPeople(h) {
    var self = readApplicant();
    var fromForm = [readUndertaker()];
    getRows(h.table, h).forEach(function (row) {
      fromForm.push(personAt(row, h.idx.a, 'A编'), personAt(row, h.idx.b, 'B编'));
    });
    var stored = [];
    try {
      var value = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      if (Array.isArray(value)) stored = value;
    } catch (e) {}
    function roster(input) {
      var people = [{ id: self.id, name: self.name, org: 'A编', lastUsed: Date.now(), isSelf: true }];
      input.forEach(function (person) {
        if (people.length >= 21 || !person || !/^\d{1,24}$/.test(person.id) ||
            typeof person.name !== 'string' || !person.name.trim() || people.some(function (p) { return p.id === String(person.id); })) return;
        people.push({
          id: String(person.id), name: person.name.trim().slice(0, 100), org: person.org === 'B编' ? 'B编' : 'A编',
          lastUsed: typeof person.lastUsed === 'number' && person.lastUsed > 0 ? person.lastUsed : Date.now(), isSelf: false,
        });
      });
      return people;
    }
    return { roster: roster(stored), peopleInForm: roster(fromForm) };
  }
  function ready(h) {
    return h && jq() && typeof WIN.addEmpty === 'function' && typeof WIN.calc === 'function' &&
      getRows(h.table, h).some(function (row) {
        var date = row.cells[h.idx.date].querySelector('input[type=text]');
        return date && !date.readOnly && !date.disabled &&
          !row.cells[h.idx.type].querySelector('select')?.disabled && !row.cells[h.idx['编制']].querySelector('select')?.disabled;
      });
  }
  var h = findTable();
  if (!ready(h)) return null;
  var current = identity(h);
  if (!current || (operation.identity && JSON.stringify(current) !== JSON.stringify(operation.identity))) return null;
  if (operation.type === 'identify') return current;
  if (operation.type === 'people') return getPeople(h);
  if (operation.type === 'savePeople') {
    var others = operation.people.filter(function (person) { return person.id !== current.accountKey; })
      .sort(function (a, b) { return b.lastUsed - a.lastUsed; }).slice(0, 20);
    localStorage.setItem(LS_KEY, JSON.stringify(others));
    return true;
  }
  var before = snapshot(h);
  if (operation.type === 'read') return before;
  if (JSON.stringify(before) !== JSON.stringify(operation.before)) return { error: 'OA 明细已变化，请重新预览' };

  function readSameForm() {
    var next = findTable();
    if (next?.table !== h.table || JSON.stringify(identity(next)) !== JSON.stringify(current)) return null;
    return snapshot(next);
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  if (operation.type === 'clear') {
    var first = getRows(h.table, h)[0];
    var remove = DOC.getElementById('delAllImg');
    if (!first || !remove || (WIN.validateRepeatRow && !WIN.validateRepeatRow(jq()(first)))) {
      return { error: '无法通过 OA 清空明细，请在原单处理' };
    }
    first.click();
    remove.click();
    for (var attempt = 0; attempt < 100; attempt++) {
      var cleared = readSameForm();
      if (!cleared) return { error: '清空后 OA 表单已变化，请在原单核对' };
      if (cleared.rows.length && cleared.rows.every(function (row) { return row.empty; })) return { snapshot: cleared };
      await wait(50);
    }
    return { error: '未读回清空结果，请在原单核对' };
  }

  var expected = before;
  var index = before.rows.findIndex(function (row) { return row.empty; });
  if (index < 0) {
    var existing = getRows(h.table, h);
    WIN.addEmpty({ data: { currentNode: existing[existing.length - 1] } });
    for (var attempt = 0; attempt < 100; attempt++) {
      var after = readSameForm();
      if (!after) return { error: '新增时 OA 表单已变化，请重新预览' };
      if (after.rows.length > before.rows.length) {
        var rows = getRows(h.table, h);
        index = rows.findIndex(function (row) { return !existing.includes(row); });
        if (rows.length !== existing.length + 1 || index < 0 || !after.rows[index].empty ||
            JSON.stringify(after.rows.filter(function (_, i) { return i !== index; })) !== JSON.stringify(before.rows)) {
          return { error: '新增后 OA 明细发生变化，请在原单核对' };
        }
        expected = after;
        break;
      }
      await wait(50);
    }
  }
  var row = getRows(h.table, h)[index];
  if (!row) return { error: '等待 OA 空白行超时，请核对后重新预览' };
  try {
    fillRow(row, h, operation.task);
    fireChange(row, h);
  } catch (e) {
    return { error: e.message || '填写失败，请核对当前明细行' };
  }

  var task = operation.task;
  for (var attempt = 0; attempt < 100; attempt++) {
    await wait(50);
    var result = readSameForm();
    var written = result?.rows[index];
    if (!written || getRows(h.table, h)[index] !== row) return { error: '回读时 OA 明细行已变化' };
    // CAP4 recalculates amounts and count displays. Check that no other row's
    // editable fields were changed while the current row was being written.
    var fields = function (item) { return [item.date, item.type, item.org, item.personId, item.personName, item.note]; };
    var other = function (items) { return items.filter(function (_, i) { return i !== index; }).map(fields); };
    if (JSON.stringify(other(result.rows)) !== JSON.stringify(other(expected.rows))) {
      return { error: '填写时其他误餐明细发生变化，请在原单核对' };
    }
    if (!WIN.calculating && written.date === task.date && written.type === task.type && written.org === task.org &&
        written.personId === task.personId && written.personName === task.personName && written.note === task.note.trim() &&
        written.amount !== '' && Number.isFinite(Number(written.amount.replace(/[,¥￥\s]/g, '')))) {
      return { snapshot: result, index: index };
    }
  }
  return { error: '第 ' + (index + 1) + ' 行回读不一致，请在原单核对后重新预览' };
}
`;

export function mealFormScript(operation: object): string {
  return `(${MEAL_FORM})(${JSON.stringify(operation)})`;
}
