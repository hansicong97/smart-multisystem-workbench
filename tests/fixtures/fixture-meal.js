// Synthetic CAP4 meal-allowance form primitives so the injected batch-fill
// enhancement runs against the same globals it uses on the real OA: jQuery
// (val/trigger), calc(), addEmpty() (async server-backed blank row),
// validateRepeatRow(), the 删除全部 button, and change-driven amount/total
// recalculation. The first detail row ships writable selectPeople cells (so a
// person can be "picked" for proxy fill); added rows ship readonly name spans
// to exercise the enhancement's buildNameCell path.
window.CurrentUserId = '277469390601667094';

const AMOUNT = { night: 15, meal: 25 };
const table = document.querySelector('#formson_200');
const body = table.tBodies[0] || table;

function dataRows() {
  return Array.from(table.querySelectorAll('tr.data-row'));
}
function recalcRow(tr) {
  const sel = tr.querySelector('select.type');
  tr.querySelector('.amount').textContent = (AMOUNT[sel.value] || 0).toFixed(2);
}
function recalcTotal() {
  let sum = 0;
  dataRows().forEach((tr) => { sum += parseFloat(tr.querySelector('.amount').textContent) || 0; });
  document.querySelector('#field0015').textContent = sum.toFixed(2);
}
function clearYellow(el) {
  if (el && /252,\s*221,\s*139/.test(el.getAttribute('style') || '')) el.style.backgroundColor = '#fff';
}

window.calc = function calc(el) {
  const tr = el && el.closest && el.closest('tr.data-row');
  if (tr) { recalcRow(tr); recalcTotal(); }
};
table.addEventListener('change', (ev) => {
  clearYellow(ev.target);
  const tr = ev.target.closest && ev.target.closest('tr.data-row');
  if (tr) { recalcRow(tr); recalcTotal(); }
});

// jQuery-lite shim covering the surface the enhancement uses.
function shim(el) {
  return {
    val(v) { if (v === undefined) return el.value; el.value = v; return this; },
    trigger(evt) { el.dispatchEvent(new Event(evt, { bubbles: true })); return this; },
  };
}
window.jQuery = shim;
window.$ = shim;
window.$.parseJSON = (raw) => JSON.parse(raw);

function readonlyName(fieldId, disp) {
  return '<span id="' + fieldId + '_span" class="browse_class" fieldval=\'{name:"' + fieldId
    + '",displayName:"' + disp + '",inputType:"member",value:""}\'>'
    + '<span class="xdRichTextBox"></span><span class="ico16 radio_people_16"></span></span>';
}
function blankRowHTML(no) {
  return '<tr class="data-row">'
    + '<td class="no">' + no + '</td>'
    + '<td><input type="text" class="xdTextBox date" style="background-color:rgb(252, 221, 139)"></td>'
    + '<td><select class="type"><option value="">请选择</option><option value="night">夜宵补贴</option><option value="meal">误正餐补贴</option></select></td>'
    + '<td><select class="org"><option value="">请选择</option><option value="A">A编</option><option value="B">B编</option></select></td>'
    + '<td>' + readonlyName('field0049', '用餐人员名称-A编') + '</td>'
    + '<td>' + readonlyName('field0050', '用餐人员名称-B编') + '</td>'
    + '<td><span class="amount">0.00</span></td>'
    + '<td><span class="src"></span></td>'
    + '<td><span class="cnt">0</span></td>'
    + '<td><input type="text" class="note"></td>'
    + '</tr>';
}
function appendRow(html) {
  const tmp = document.createElement('tbody');
  tmp.innerHTML = html;
  body.appendChild(tmp.firstChild);
}

let rowSeq = dataRows().length;
// CAP4's server-backed blank add is asynchronous; the enhancement polls for it.
window.addEmpty = function addEmpty() {
  setTimeout(() => { rowSeq += 1; appendRow(blankRowHTML(rowSeq)); }, 30);
};
window.validateRepeatRow = function validateRepeatRow() { return true; };

const delAll = document.querySelector('#delAllImg');
if (delAll) {
  delAll.addEventListener('click', () => {
    dataRows().forEach((tr) => tr.remove());
    rowSeq = 1;
    appendRow(blankRowHTML(1));
    recalcTotal();
  });
}

// Client-side clone add copies the row DOM (values and markup) but drops
// listeners; the enhancement queries rows fresh so cloned rows stay fillable.
const clone = document.querySelector('#meal-clone-row');
if (clone) {
  clone.addEventListener('click', () => {
    const rows = dataRows();
    rowSeq += 1;
    const c = rows[rows.length - 1].cloneNode(true);
    c.querySelector('.no').textContent = String(rowSeq);
    body.appendChild(c);
  });
}
