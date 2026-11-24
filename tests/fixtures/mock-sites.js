import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const labels = { oa: 'OA', gitlab: 'GitLab', zentao: '禅道' };
const oaLogin = '/seeyon/index.jsp';
const oaHome = '/seeyon/main.do?method=main';
const timeHome = '/ws/pages/worksheet/my-work.html';
const zentaoLogin = '/user-login-L215Lmh0bWw=.html';

function html(title, content) {
  return `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
    <link rel="stylesheet" href="/fixture.css"><script src="/fixture.js" defer></script></head>
    <body><main><h1>${title}</h1>${content}</main></body></html>`;
}

function loginStatus(signedIn) {
  return `<p id="login-status" role="status">${signedIn ? '已模拟登录' : '未登录'}</p>`;
}

function loginForm(id, action) {
  return `<form method="post" action="/${id}/login"><button type="submit">${action}</button></form>`;
}

function sitePage(id, route, otherOrigin, signedIn) {
  const name = labels[id];
  const home = { oa: oaHome, gitlab: '/', zentao: '/my.html' }[id];
  if (route === 'popup') return html(`${name} 模拟弹窗`, `
    <p id="opener"></p><button id="return" type="button">回传并关闭</button>`);
  if (route === 'detail') return html(`${name} 模拟详情`, `<a href="${home}">返回模拟首页</a>`);
  return html(`${name} 模拟首页`, `
    ${loginStatus(signedIn)}
    <div class="actions">
      ${loginForm(id, signedIn ? '退出模拟登录' : '模拟登录')}
      <a href="/${id}/detail">查看详情</a>
      <button id="open-popup" type="button" data-url="/${id}/popup">打开弹窗</button>
      <a href="/${id}/download" download>下载样例</a>
      ${id === 'oa' ? `
        <a href="/ws/entry" target="_blank">进入工时</a>
        <a href="/oa/travel">差旅申请</a>
        <a href="/oa/meal">误餐补贴</a>
        <a href="/oa/popup" target="_blank">打开链接子页</a>
        <form method="post" action="/oa/post-popup" target="_blank">
          <input type="hidden" name="example" value="synthetic">
          <button type="submit">提交子页表单</button>
        </form>` : ''}
    </div>
    <p><label>本页草稿 <input type="text" autocomplete="off"></label></p>
    <p id="popup-result" role="status" hidden></p>
    <details>
      <summary>来源限制</summary>
      <div class="actions">
        <a href="${otherOrigin}/frame">跳转到 iframe 来源</a>
        <a href="/${id}/redirect">重定向到 iframe 来源</a>
        <a href="${otherOrigin}/frame" target="_blank" rel="noopener">弹窗打开 iframe 来源</a>
      </div>
    </details>
    <iframe title="外层 iframe" src="${otherOrigin}/frame"></iframe>`);
}

function cityField(name, displayName, value) {
  const fv = JSON.stringify({
    name, isMasterFiled: 'false', displayName, fieldType: 'VARCHAR', inputType: 'text',
    formatType: '', value, toRelationType: 'form_relation_field', setColor: 'true',
  });
  return `<span id="${name}_span" class="browse_class" fieldval='${fv}'>`
    + `<span name="${name}" id="${name}" class="xdRichTextBox validate" role="textbox">${value}</span>`
    + `<span class="ico16 correlation_form_16" name="${name}" hasrelatied="${value ? 'true' : 'false'}" relation="{}"></span>`
    + '</span>';
}

// A synthetic CAP4-style form body: repeating grid with paired data-relation
// city fields, served from the same origin inside #zwIframe like the real OA.
function formPage() {
  return `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>差旅表单</title>
    <link rel="stylesheet" href="/fixture.css"><script src="/fixture-form.js" defer></script></head>
    <body><main>
    <table class="xdRepeatingTable" id="formson_100">
      <tr><th>出发地</th><th>目的地</th></tr>
      <tr class="data-row"><td>${cityField('field0001', '飞机票-出发地新增', '')}</td><td>${cityField('field0002', '飞机票-目的地新增', '')}</td></tr>
    </table>
    <button id="add-row" type="button">添加一行</button>
    <button id="add-row-fresh" type="button">空白新增</button>
    </main></body></html>`;
}

// A writable selectPeople cell (hidden id + readonly text + fieldval span), as
// left behind after the user picks someone with the form's own people picker.
function writableName(fieldId, displayName) {
  const fv = `{name:"${fieldId}",isMasterFiled:"false",displayName:"${displayName}",fieldType:"VARCHAR",inputType:"member",formatType:"1",value:""}`;
  return `<span id="${fieldId}_span" class="editableSpan edit_class" fieldval='${fv}'>`
    + `<input type="text" id="${fieldId}_txt" name="${fieldId}_txt" class="xdTextBox" readonly>`
    + `<input type="hidden" id="${fieldId}" name="${fieldId}">`
    + '<span class="ico16 radio_people_16 _autoBtn"></span></span>';
}

// A synthetic CAP4 meal-allowance form: header-keyed detail grid, applicant /
// undertaker / total fields, and the row toolbar. Served from the same origin
// inside #zwIframe like the travel form, distinguished by moduleId.
function mealFormPage() {
  return `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>误餐补贴表单</title>
    <link rel="stylesheet" href="/fixture.css"><script src="/fixture-meal.js" defer></script></head>
    <body><main>
    <p>申请人：<span id="field0003">张三</span></p>
    <p>承担人：<input type="hidden" id="field0073" value=""><input type="text" id="field0073_txt" value="" aria-label="承担人"></p>
    <p>合计：<span id="field0015">0.00</span> 元</p>
    <table class="xdRepeatingTable" id="formson_200">
      <tr><th>序号</th><th>申请日期</th><th>补贴类型</th><th>用餐人员编制</th><th>姓名（A编）</th><th>姓名（B编）</th><th>补贴金额</th><th>当日已补贴次数来源</th><th>当日已补贴次数</th><th>备注</th></tr>
      <tr class="data-row">
        <td class="no">1</td>
        <td><input type="text" class="xdTextBox date" style="background-color:rgb(252, 221, 139)"></td>
        <td><select class="type"><option value="">请选择</option><option value="night">夜宵补贴</option><option value="meal">误正餐补贴</option></select></td>
        <td><select class="org"><option value="">请选择</option><option value="A">A编</option><option value="B">B编</option></select></td>
        <td>${writableName('field0049', '用餐人员名称-A编')}</td>
        <td>${writableName('field0050', '用餐人员名称-B编')}</td>
        <td><span class="amount">0.00</span></td>
        <td><span class="src"></span></td>
        <td><span class="cnt">0</span></td>
        <td><input type="text" class="note"></td>
      </tr>
    </table>
    <button id="meal-clone-row" type="button">克隆新增</button>
    <button id="delAllImg" type="button">删除全部</button>
    </main></body></html>`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

export async function startMockSites() {
  const [style, script, formScript, mealScript] = await Promise.all(['fixture.css', 'fixture.js', 'fixture-form.js', 'fixture-meal.js'].map((name) =>
    readFile(new URL(name, import.meta.url), 'utf8'),
  ));
  let siteOrigin;
  let frameOrigin;

  const handler = (isSite) => async (request, response) => {
    const path = request.url.split('?', 1)[0];
    const signedIn = request.headers.cookie?.split('; ').includes('smsw_mock_login=1') ?? false;
    const otherOrigin = isSite ? frameOrigin : siteOrigin;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // The host, rather than fixture CSP, checks which loopback frame ports are allowed.
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; frame-src http://127.0.0.1:*; form-action 'self'; base-uri 'none'");

    function send(type, body) {
      response.setHeader('Content-Type', `${type}; charset=utf-8`);
      response.end(body);
    }

    function redirect(location, status = 302) {
      response.writeHead(status, { Location: location });
      response.end();
    }

    if (path === '/fixture.css') return send('text/css', style);
    if (path === '/fixture.js') return send('text/javascript', script);
    if (path === '/fixture-form.js') return send('text/javascript', formScript);
    if (path === '/fixture-meal.js') return send('text/javascript', mealScript);
    if (path === '/frame') return send('text/html', html('外层 iframe', `
      <a href="${otherOrigin}/oa/popup" target="_blank">从 iframe 打开 OA 子页</a>
      <iframe title="内层 iframe" src="${otherOrigin}/inner-frame"></iframe>`));
    if (path === '/inner-frame') return send('text/html', html('内层 iframe', `
      <label>费用类型 <select><option>请选择</option><option>差旅费</option></select></label>
      <label>附件 <input type="file" accept=".txt,.pdf"></label>`));
    if (path === '/frame-redirect') {
      const port = Number(new URL(request.url, siteOrigin).searchParams.get('port'));
      if (Number.isInteger(port) && port > 0 && port <= 65535) return redirect(`http://127.0.0.1:${port}/probe`);
    }

    if (isSite && path === oaLogin) {
      if (signedIn) return redirect(oaHome);
      return send('text/html', html('OA 模拟登录', loginStatus(false) + loginForm('oa', '模拟登录')));
    }
    if (isSite && path === '/seeyon/main.do') {
      if (!signedIn) return redirect(oaLogin);
      return send('text/html', sitePage('oa', null, otherOrigin, signedIn));
    }
    if (isSite && path === '/oa/travel') {
      if (!signedIn) return redirect(oaLogin);
      return send('text/html', html('OA 差旅申请', `
        <iframe id="zwIframe" title="表单 iframe" src="${siteOrigin}/seeyon/content/content.do?method=index&moduleId=synthetic-travel"></iframe>`));
    }
    if (isSite && path === '/oa/meal') {
      if (!signedIn) return redirect(oaLogin);
      // The batch-fill panel is a tall fixed overlay; give the form frame the
      // full viewport so the panel (which scrolls internally) stays clickable.
      return send('text/html', `<!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8"><title>OA 误餐补贴</title>
        <link rel="stylesheet" href="/fixture.css">
        <style>main{padding:8px}iframe#zwIframe{height:calc(100vh - 16px)}</style></head>
        <body><main>
        <iframe id="zwIframe" title="表单 iframe" src="${siteOrigin}/seeyon/content/content.do?method=index&moduleId=synthetic-meal"></iframe>
        </main></body></html>`);
    }
    if (isSite && path === '/seeyon/content/content.do') {
      const moduleId = new URL(request.url, siteOrigin).searchParams.get('moduleId');
      return send('text/html', moduleId === 'synthetic-meal' ? mealFormPage() : formPage());
    }
    if (isSite && path === '/ws/entry') return redirect(signedIn ? timeHome : oaLogin);
    if (isSite && path === timeHome) {
      if (!signedIn) return redirect(oaLogin);
      return send('text/html', html('工时模拟首页', `${loginStatus(true)}<p>此模拟页面沿用 OA 会话。</p>`));
    }
    if (isSite && path === '/oa/post-popup' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (new URLSearchParams(body).get('example') === 'synthetic') return redirect('/oa/popup', 303);
    }
    if (isSite && path === '/') return send('text/html', sitePage('gitlab', null, otherOrigin, signedIn));
    if (!isSite && path === '/my.html') {
      if (!signedIn) return redirect(zentaoLogin);
      return send('text/html', sitePage('zentao', null, otherOrigin, signedIn));
    }
    if (!isSite && path === zentaoLogin) {
      return send('text/html', html('禅道 模拟登录', loginStatus(false) + loginForm('zentao', '模拟企业微信扫码')));
    }

    const match = path.match(/^\/(oa|gitlab|zentao)\/(detail|popup|download|redirect|login)$/u);
    if (match && isSite === (match[1] !== 'zentao')) {
      const [, id, route] = match;
      if (route === 'login' && request.method === 'POST') {
        response.setHeader('Set-Cookie', `smsw_mock_login=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${signedIn ? 0 : 86400}`);
        return redirect({ oa: oaLogin, gitlab: '/', zentao: '/my.html' }[id], 303);
      }
      if (route === 'download') {
        response.setHeader('Content-Disposition', `attachment; filename="${id}-sample.txt"`);
        return send('text/plain', `SMSW synthetic download for ${id}\n`);
      }
      if (route === 'redirect') return redirect(`${otherOrigin}/frame`);
      if (route === 'detail' || route === 'popup') return send('text/html', sitePage(id, route, otherOrigin, signedIn));
    }

    response.statusCode = 404;
    send('text/plain', '页面不存在');
  };

  const site = createServer(handler(true));
  const frames = createServer(handler(false));
  const close = () => {
    site.close();
    frames.close();
  };
  try {
    siteOrigin = await listen(site);
    frameOrigin = await listen(frames);
    return { siteOrigin, frameOrigin, close };
  } catch (error) {
    close();
    throw error;
  }
}
