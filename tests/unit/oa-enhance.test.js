import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CITY_SWAP_SCRIPT, isOaFormFrame } from '../../dist/main/oa-enhance.js';

test('仅 OA 的 CAP4 表单帧触发增强注入', () => {
  const form = 'https://oa.example.test/seeyon/content/content.do?method=index&moduleId=-123&isFullPage=true';
  assert.equal(isOaFormFrame('oa', form), true);
  assert.equal(isOaFormFrame('gitlab', form), false);
  assert.equal(isOaFormFrame('zentao', form), false);
  assert.equal(isOaFormFrame('oa', 'https://oa.example.test/seeyon/content/content.do?method=view'), false);
  assert.equal(isOaFormFrame('oa', 'https://oa.example.test/seeyon/main.do?method=main'), false);
  assert.equal(isOaFormFrame('oa', 'https://oa.example.test/seeyon/content/content.do'), false);
  assert.equal(isOaFormFrame('oa', 'not a url'), false);
});

test('城市互换脚本包含幂等守卫与按行互换逻辑', () => {
  assert.match(CITY_SWAP_SCRIPT, /__smswCitySwap/);
  assert.match(CITY_SWAP_SCRIPT, /form_relation_field/);
  assert.match(CITY_SWAP_SCRIPT, /afterFormFieldCalc/);
  assert.match(CITY_SWAP_SCRIPT, /data-smsw-swap/);
  // 点击走文档级委托：CAP4 左侧新增会克隆按钮 DOM 但丢失监听器。
  assert.match(CITY_SWAP_SCRIPT, /document\.addEventListener\('click'/);
});
