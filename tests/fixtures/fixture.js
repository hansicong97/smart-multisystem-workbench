const openPopup = document.querySelector('#open-popup');
if (openPopup) {
  openPopup.addEventListener('click', () => window.open(openPopup.dataset.url, '_blank'));
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data !== 'smsw-popup-confirmed') return;
    const result = document.querySelector('#popup-result');
    result.textContent = '已收到弹窗结果';
    result.hidden = false;
  });
}

const sendBack = document.querySelector('#return');
if (sendBack) {
  document.querySelector('#opener').textContent = window.opener ? '已连接来源页面' : '来源页面不可用';
  sendBack.addEventListener('click', () => {
    window.opener?.postMessage('smsw-popup-confirmed', location.origin);
    window.close();
  });
}
