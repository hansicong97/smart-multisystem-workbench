const fields = [
  ['major', '费用大类', ['差旅费']],
  ['minor', '费用小类', ['火车票', '境内机票', '境外机票', '出差补贴', '出租车费']],
  ['date', '发票日期'],
  ['invoiceType', '发票类型', ['增值税专用发票', '增值税电子专用发票', '增值税电子普通发票', '增值税普通发票', '其他发票']],
  ['amount', '发票金额(价税合计)'],
  ['tax', '税额'],
  ['invoiceNumber', '发票号'],
  ['summary', '摘要'],
];

function input([key, label, options], cap4, index) {
  const id = 'field' + (5500 + index);
  const attrs = 'data-field="' + key + '" aria-label="' + label + '"' + (cap4 ? ' id="' + id + '" name="' + id + '"' : '');
  const model = (field, type) => cap4
    ? '<span id="' + id + '_span" fieldval=\'' + JSON.stringify({ name: id, inputType: type, value: '' }) + '\'>' + field + '</span>'
    : '<span fieldval=\'{"value":""}\'>' + field + '</span>';
  const display = '<input type="text" id="' + id + '_txt">';
  if (options) {
    const choices = options.map((name, index) => '<option value="' + key + '-' + index + '">' + name + '</option>').join('');
    const select = '<select ' + attrs + '><option value="">请选择</option>' + (cap4 && key === 'minor' ? '' : choices) + '</select>';
    if (cap4) return model(select + display + (key === 'minor'
      ? '<input type="button" name="acToggle" value="选择"><template>' + choices + '</template>' : ''), 'select');
    return select;
  }
  const field = key === 'summary' && !cap4 ? '<textarea ' + attrs + '></textarea>' : '<input type="text" ' + attrs + '>';
  return model(field + (cap4 && key === 'amount' ? display : ''), 'text');
}

export function reimbursementPage(url) {
  const add = url.searchParams.get('add') === 'clone' ? 'clone' : 'blank';
  const cap4 = url.searchParams.get('controls') === 'cap4';
  const cells = fields.map((spec, index) => '<td>' + input(spec, cap4, index) + '</td>').join('');
  const file = '<input type="file" accept=".pdf" aria-label="本行附件">';
  const attachment = cap4
    ? '<span fieldval=\'{"inputType":"attachment","value":""}\'><input type="hidden" id="fixture_editAtt" value="true">' + file + '</span>'
    : file;
  const row = '<tr class="data-row">' + (cap4 ? '<td><input type="hidden" name="id" value="fixture-row">1</td>' : '') +
    cells + '<td>' + attachment + '</td></tr>';
  const headers = (cap4 ? '<th>序号</th>' : '') + fields.map(([, label]) => '<th>' + label + '</th>').join('');
  return ['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>差旅报销单</title>',
    '<link rel="stylesheet" href="/fixture.css"><script src="/fixture-reimbursement.js" defer></script></head>',
    '<body' + (cap4 ? ' data-cap4="true"' : '') + '><main data-reimbursement-document="OA-DEMO-' +
      (url.searchParams.get('document') === '043' ? '043' : '042') + '"><h1>差旅报销单</h1>',
    cap4 ? '<table><tr><td>代办人</td><td>模拟报销用户</td></tr></table>' : '<p>账号 <span data-oa-account>模拟报销用户</span></p>',
    '<p>费用合计 <span fieldval=\'{"displayName":"报销汇总-合计","value":"0.00"}\'><output id="reimbursement-total">0.00</output></span> 元</p>',
    '<table class="xdRepeatingTable" id="reimburse-grid"><thead><tr>' + headers + '<th>发票文件</th></tr></thead>',
    '<tbody>' + row + '</tbody></table><template id="reimbursement-empty">' + row + '</template>',
    cap4 ? '' : '<button type="button" id="reimbursement-add-' + add + '">' + (add === 'clone' ? '克隆新增' : '空白新增') + '</button>',
    '<button type="button" id="reimbursement-save">保存</button><button type="button" id="reimbursement-submit">发送</button>',
    '<p>保存次数 <output id="reimbursement-saves">0</output>，发送次数 <output id="reimbursement-submits">0</output></p>',
    '</main></body></html>'].join('');
}
