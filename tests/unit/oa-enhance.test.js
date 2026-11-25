import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CITY_SWAP_SCRIPT, buildMealPlan, diffMealFill, isOaFormFrame, mealFormScript } from '../../dist/main/oa-enhance.js';

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

// ---- 误餐补贴批量规划器 ----
const person = (id, name, org = 'A编') => ({ id, name, org });
const mealCfg = (over = {}) => ({
  start: '2026-10-08', end: '2026-10-09', skipWeekend: false, skipText: '', noteText: '',
  entries: ['夜宵补贴', '误正餐补贴'], people: [person('1', '张三')], ...over,
});

test('规划器按区间展开并估算金额', () => {
  const plan = buildMealPlan(mealCfg());
  assert.equal(plan.days, 2);
  assert.equal(plan.rows, 4); // 2 天 × 2 类
  assert.equal(plan.sum, 80); // (15 + 25) × 2
  assert.equal(plan.first, '2026-10-08');
  assert.equal(plan.last, '2026-10-09');
  assert.deepEqual(plan.tasks.map((t) => t.date), ['2026-10-08', '2026-10-08', '2026-10-09', '2026-10-09']);
});

test('跳过日期支持多种连接符、注释与去重', () => {
  const plan = buildMealPlan(mealCfg({
    start: '2026-10-01', end: '2026-10-05',
    skipText: '# 国庆\n2026-10-01～2026-10-03\n2026-10-03、2026-10-04',
  }));
  assert.deepEqual(plan.tasks.map((t) => t.date).filter((d, i, a) => a.indexOf(d) === i), ['2026-10-05']);
});

test('跳过周六日只保留工作日', () => {
  const cfg = mealCfg({ start: '2026-10-05', end: '2026-10-11', skipWeekend: true, entries: ['夜宵补贴'] });
  const plan = buildMealPlan(cfg);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const expected = [];
  for (let d = new Date(2026, 9, 5); d <= new Date(2026, 9, 11); d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) expected.push(local(d));
  }
  assert.deepEqual(plan.tasks.map((t) => t.date), expected);
});

test('备注只落在真正填入的日期上', () => {
  const plan = buildMealPlan(mealCfg({ skipText: '2026-10-08', noteText: '2026-10-08~2026-10-09 = 加班' }));
  assert.deepEqual(plan.tasks.map((t) => t.date), ['2026-10-09', '2026-10-09']);
  assert.deepEqual(plan.tasks.map((t) => t.note), ['加班', '加班']);
});

test('多人按人员优先排序，各用各的编制', () => {
  const plan = buildMealPlan(mealCfg({
    start: '2026-10-08', end: '2026-10-08',
    people: [person('1', '甲'), person('2', '乙', 'B编')],
  }));
  assert.deepEqual(plan.tasks.map((t) => t.personId), ['1', '1', '2', '2']);
  assert.deepEqual(plan.tasks.map((t) => t.type), ['夜宵补贴', '误正餐补贴', '夜宵补贴', '误正餐补贴']);
  assert.deepEqual(plan.tasks.map((t) => t.org), ['A编', 'A编', 'B编', 'B编']);
  assert.deepEqual(plan.byPerson.map((b) => [b.name, b.org, b.rows, b.sum]), [['甲', 'A编', 2, 40], ['乙', 'B编', 2, 40]]);
  assert.equal(plan.sum, 80);
});

test('规划器拒绝非法配置', () => {
  assert.throws(() => buildMealPlan(mealCfg({ start: '2026-10-09', end: '2026-10-08' })), /结束日期早于开始日期/);
  assert.throws(() => buildMealPlan(mealCfg({ skipText: '2026-10-08~2026-10-09' })), /没有要填的日期/);
  assert.throws(() => buildMealPlan(mealCfg({ entries: [] })), /至少勾选一种补贴类型/);
  assert.throws(() => buildMealPlan(mealCfg({ people: [] })), /至少选择一名用餐人员/);
});

test('续填差异：匹配行跳过、空行复用、冲突行保留', () => {
  const tasks = buildMealPlan(mealCfg({ start: '2026-10-08', end: '2026-10-08' })).tasks; // 夜宵 + 正餐
  const existing = [
    { date: '2026-10-08', type: '夜宵补贴', personId: '1', personName: '张三', org: 'A编', empty: false },
    { date: '', type: '', personId: '', personName: '', org: '', empty: true },
    { date: '2026-10-09', type: '夜宵补贴', personId: '1', personName: '张三', org: 'A编', empty: false },
  ];
  const diff = diffMealFill(existing, tasks);
  assert.equal(diff.matchedCount, 1);
  assert.deepEqual(diff.fillTasks.map((t) => t.type), ['误正餐补贴']);
  assert.equal(diff.emptyCount, 1);
  assert.equal(diff.needNew, 0);
  assert.equal(diff.conflicts.length, 1);
  assert.equal(diff.conflicts[0].date, '2026-10-09');
});

test('续填差异：空行不足时计算需新增行数', () => {
  const tasks = buildMealPlan(mealCfg()).tasks; // 4 行
  const diff = diffMealFill([{ date: '', type: '', personId: '', personName: '', org: '', empty: true }], tasks);
  assert.equal(diff.fillTasks.length, 4);
  assert.equal(diff.emptyCount, 1);
  assert.equal(diff.needNew, 3);
});

test('误餐 CAP4 适配沿用原名册并核对表单实例和明细快照', () => {
  const script = mealFormScript({ type: 'read', instance: 'fixture' });
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /__smswMealPeople/);
  assert.match(script, /__smswMealForms/);
  assert.match(script, /JSON\.stringify\(before\) !== JSON\.stringify\(operation\.before\)/);
  assert.doesNotMatch(script, /__smswMeal(ConfirmYes|Panel|Toggle)|confirm\(/);
});
