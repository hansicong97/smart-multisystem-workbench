// Minimal CAP4 stand-ins so the injected enhancement runs against the same
// primitives it uses on the real OA: $.parseJSON, $.ctp.trigger and getFields().
window.$ = { parseJSON: (raw) => JSON.parse(raw), ctp: { trigger: () => {} } };
window.getFields = function getFields() {
  const fields = [];
  document.querySelectorAll("span[id^='field']").forEach((span) => {
    const raw = span.getAttribute('fieldval');
    if (raw) fields.push(JSON.parse(raw));
  });
  return fields;
};

const grid = document.querySelector('#formson_100');

// CAP4's left-side row add clones the current row client-side: values AND any
// injected button markup are copied, but cloneNode drops event listeners. The
// enhancement must survive this (document-level click delegation).
const addRow = document.querySelector('#add-row');
if (addRow && grid) {
  addRow.addEventListener('click', () => {
    const rows = grid.querySelectorAll('tr.data-row');
    grid.appendChild(rows[rows.length - 1].cloneNode(true));
  });
}

// A blank row add returns fresh server-rendered HTML: no injected markup, empty
// values; the enhancement's MutationObserver decorates it.
const addFresh = document.querySelector('#add-row-fresh');
if (addFresh && grid) {
  addFresh.addEventListener('click', () => {
    const clone = grid.querySelector('tr.data-row').cloneNode(true);
    clone.querySelectorAll('[data-smsw-swap]').forEach((button) => button.remove());
    clone.querySelectorAll('span[id$="_span"]').forEach((span) => {
      const fv = JSON.parse(span.getAttribute('fieldval'));
      fv.value = '';
      span.setAttribute('fieldval', JSON.stringify(fv));
    });
    clone.querySelectorAll('.xdRichTextBox').forEach((el) => { el.textContent = ''; });
    clone.querySelectorAll('.correlation_form_16').forEach((el) => el.setAttribute('hasrelatied', 'false'));
    grid.appendChild(clone);
  });
}
