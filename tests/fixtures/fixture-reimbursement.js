const table = document.querySelector('#reimburse-grid');
const tbody = table.tBodies[0];
const template = document.querySelector('#reimbursement-empty');
const total = document.querySelector('#reimbursement-total');

function controls(row) {
  return Array.from(row.querySelectorAll('[data-field]'));
}

function writeModel(input) {
  if (input.matches('[data-field="amount"]') && document.body.dataset.clamp === 'true' && input.value === '56.20') {
    input.value = '56.00';
  }
  const wrapper = input.closest('[fieldval]');
  if (wrapper) {
    const field = JSON.parse(wrapper.getAttribute('fieldval'));
    wrapper.setAttribute('fieldval', JSON.stringify({ ...field, value: input.value }));
  }
}

function updateTotal() {
  const cents = Array.from(tbody.rows).reduce((sum, row) => {
    const amount = row.querySelector('[data-field=amount]').value;
    return sum + Math.round((Number(amount) || 0) * 100);
  }, 0);
  total.textContent = (cents / 100).toFixed(2);
}

for (const type of ['input', 'change', 'focusout']) {
  table.addEventListener(type, (event) => {
    if (!event.target.matches('[data-field]')) return;
    writeModel(event.target);
    updateTotal();
  });
}
document.querySelector('#reimbursement-add-blank')?.addEventListener('click', () => {
  setTimeout(() => tbody.append(template.content.firstElementChild.cloneNode(true)), 80);
});
document.querySelector('#reimbursement-add-clone')?.addEventListener('click', () => {
  const prior = tbody.rows[tbody.rows.length - 1];
  const next = prior.cloneNode(true);
  controls(next).forEach((control, index) => {
    control.value = controls(prior)[index].value;
    writeModel(control);
  });
  tbody.append(next);
  updateTotal();
});
window.CurrentUserId = 'fixture-oa-user';
if (document.body.dataset.cap4 === 'true') {
  window.Set = function LegacySet() {};
  window.$ = { parseJSON: JSON.parse };
  window.calculating = false;
  window.addEmpty = ({ data }) => setTimeout(() => {
    const row = template.content.firstElementChild.cloneNode(true);
    const attachment = row.querySelector('input[id$=_editAtt]').closest('[fieldval]');
    attachment.setAttribute('fieldval', JSON.stringify({ inputType: 'attachment', value: '3000000000000000001' }));
    data.currentNode.after(row);
  }, 80);
  window.formPreSubmitData = (callback) => setTimeout(callback, 80);
  window.calc = (control, all) => {
    window.calculating = true;
    setTimeout(() => {
      const row = control.closest('tr');
      if (all) {
        const selected = row.querySelector('[data-field=minor]');
        selected.value = '';
        row.querySelector('[id="' + selected.id + '_txt"]').value = '';
        writeModel(selected);
      }
      updateTotal();
      window.calculating = false;
    }, 100);
  };
  table.addEventListener('change', (event) => {
    const control = event.target;
    if (control.dataset.field === 'major') {
      const minor = control.closest('tr').querySelector('[data-field=minor]');
      const options = minor.parentElement.querySelector('template').content.cloneNode(true);
      setTimeout(() => {
        while (minor.options.length > 1) minor.remove(1);
        minor.append(options);
      }, 80);
    }
    if (control.dataset.field === 'minor') window.calc(control, false);
  });
  table.addEventListener('click', (event) => {
    if (!event.target.matches('input[name=acToggle]')) return;
    const parent = event.target.parentElement;
    const select = parent.querySelector('select');
    const display = parent.querySelector('input[id$=_txt]');
    display.focus();
    document.querySelector('.autocomplete-popup')?.remove();
    const popup = document.createElement('div');
    popup.className = 'autocomplete-popup';
    const menu = document.createElement('div');
    menu.className = 'menu';
    popup.append(menu);
    const acceptsSelectionAfter = performance.now() + 180;
    for (const option of [...select.options].filter(({ value }) => value)) {
      const item = document.createElement('div');
      item.className = 'item';
      item.textContent = option.text;
      item.addEventListener('mouseover', () => { item.dataset.active = 'true'; });
      item.addEventListener('mousedown', () => {
        popup.remove();
        if (item.dataset.active !== 'true' || performance.now() < acceptsSelectionAfter) return;
        select.value = option.value;
        display.value = option.text;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.append(item);
    }
    document.body.append(popup);
  });
}
for (const name of ['save', 'submit']) {
  document.querySelector('#reimbursement-' + name).addEventListener('click', () => {
    const output = document.querySelector('#reimbursement-' + name + 's');
    output.textContent = String(Number(output.textContent) + 1);
  });
}
document.body.dataset.ready = 'true';
