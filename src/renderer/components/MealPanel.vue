<template>
  <form class="meal-tool" @submit.prevent="prepare">
    <h3>误餐补贴</h3>
    <fieldset :disabled="!!busy">
      <details :open="peopleOpen" @toggle="peopleOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ selectionLabel }}</summary>
        <div class="meal-people">
          <div v-for="person in roster" :key="person.id" class="meal-person">
            <label><input v-model="checked" type="checkbox" :value="person.id"> {{ person.name }}{{ person.isSelf ? '（我）' : '' }}</label>
            <select v-model="person.org" :aria-label="person.name + '的编制'" @change="savePeople">
              <option v-for="org in mealOrg.options" :key="org">{{ org }}</option>
            </select>
            <button v-if="!person.isSelf" type="button" class="icon-button" :aria-label="'移除' + person.name" @click="remove(person.id)">
              <AppIcon name="close" :size="14" />
            </button>
          </div>
        </div>
      </details>
      <div class="assistant-actions">
        <button type="button" class="assistant-action" @click="readPeople">从表单读取</button>
        <button type="button" class="assistant-action" @click="onlyApplicant">仅申请人</button>
      </div>
      <div class="meal-dates">
        <label>开始日期 <input v-model="dates.start" type="date" required></label>
        <label>结束日期 <input v-model="dates.end" type="date" required></label>
      </div>
      <label class="meal-check"><input v-model="skipWeekend" type="checkbox"> 跳过周六日</label>
      <details class="meal-options">
        <summary>排除日期与备注</summary>
        <label>排除日期 <textarea v-model="skipText" rows="2" maxlength="4000" placeholder="2026-10-01~2026-10-07"></textarea></label>
        <label>加班备注 <textarea v-model="noteText" rows="2" maxlength="4000" placeholder="2026-10-03 = 国庆加班"></textarea></label>
      </details>
      <div class="assistant-actions">
        <label v-for="type in mealType.options" :key="type" class="meal-check">
          <input v-model="entries" type="checkbox" :value="type"> {{ type }}
        </label>
      </div>
      <label class="meal-check"><input v-model="clearFirst" type="checkbox"> 填入前清空已有明细</label>
      <button type="submit" class="assistant-action assistant-primary" :disabled="!roster.length">预览误餐填写</button>
    </fieldset>
    <p v-if="busy" class="meal-status" role="status">{{ busy }}</p>
    <p v-if="error" class="meal-error" role="alert">{{ error }}</p>
    <section v-if="preview" class="meal-checkpoint" aria-label="误餐填写预览">
      <strong>{{ preview.document }}</strong>
      <span>{{ preview.first }} 至 {{ preview.last }} · {{ preview.rows }} 行 · 预计 ¥{{ preview.sum.toFixed(2) }}</span>
      <span>已匹配 {{ preview.matched }} 行 · 待填 {{ preview.pending }} 行</span>
      <span>复用空行 {{ preview.reuse }} 行 · 新增 {{ preview.add }} 行</span>
      <span v-if="preview.conflicts">已有 {{ preview.conflicts }} 行与计划不一致，将保留原行。</span>
      <strong v-if="preview.clear">本次将清空已有误餐明细后填写。</strong>
      <p v-if="preview.blocked" class="meal-error" role="alert">{{ preview.blocked }}</p>
      <div class="assistant-actions">
        <button type="button" class="assistant-action assistant-primary" :disabled="!!busy || !!preview.blocked" @click="fill">确认填写</button>
        <button type="button" class="assistant-action" @click="preview = undefined">取消</button>
      </div>
    </section>
    <section v-if="result" class="meal-checkpoint" aria-label="误餐填写结果">
      <strong role="status">{{ result.message }}</strong>
      <span>已回读 {{ result.read.length }} 行 · 已匹配 {{ result.matched }} 行 · 待处理 {{ result.pending.length }} 行</span>
      <span v-if="result.total">OA 合计 ¥{{ result.total }}</span>
      <details v-if="result.read.length"><summary>已回读明细</summary><ol><li v-for="item in result.read" :key="item">{{ item }}</li></ol></details>
      <details v-if="result.pending.length" open><summary>待处理明细</summary><ol><li v-for="item in result.pending" :key="item">{{ item }}</li></ol></details>
    </section>
  </form>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { mealOrg, mealType } from '../../shared/assistant.js';
import type { MealCommand, MealInput, MealPreview, MealReply, MealResult, MealRosterPerson, PageAssistant } from '../../shared/assistant.js';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ target: PageAssistant; visible: boolean }>();
const api = window.workbench;
const checked = ref<string[]>([]);
const roster = ref<MealRosterPerson[]>([]);
const peopleOpen = ref(false);
const skipWeekend = ref(true);
const skipText = ref('');
const noteText = ref('');
const entries = ref<MealInput['entries']>([...mealType.options]);
const clearFirst = ref(false);
const busy = ref('');
const error = ref('');
const preview = ref<MealPreview>();
const result = ref<MealResult>();

const today = new Date();
const ymd = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
  .map((value) => String(value).padStart(2, '0')).join('-');
const dates = reactive({
  start: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
  end: ymd(new Date(today.getFullYear(), today.getMonth(), 0)),
});
const selected = computed(() => roster.value.filter(({ id }) => checked.value.includes(id)));
const selectionLabel = computed(() => selected.value.length
  ? `已选 ${selected.value.length} 人：${selected.value.map(({ name }) => name).join('、')}` : '未选择用餐人员');
const input = computed<MealInput>(() => ({
  ...dates, skipWeekend: skipWeekend.value, skipText: skipText.value, noteText: noteText.value,
  entries: [...entries.value], people: selected.value.map(({ id, name, org }) => ({ id, name, org })), clearFirst: clearFirst.value,
}));

watch(input, () => { preview.value = undefined; }, { flush: 'sync' });
watch(() => props.target.revision, () => { preview.value = undefined; error.value = ''; });
watch(() => props.visible, (visible) => {
  if (!visible) preview.value = undefined;
  else if (!roster.value.length) void load();
}, { immediate: true });

async function request(command: MealCommand, label = ''): Promise<MealReply> {
  if (busy.value) return {};
  busy.value = label || '正在读取误餐表单';
  error.value = '';
  try {
    const reply = await api?.meal({ target: props.target, command }) ?? { error: '无法连接桌面宿主' };
    error.value = reply.error ?? '';
    return reply;
  } catch {
    error.value = '无法完成误餐操作，请重试';
    return { error: error.value };
  } finally {
    busy.value = '';
  }
}

async function load() {
  const reply = await request({ type: 'state' });
  if (!reply.roster) return;
  roster.value = reply.roster;
  onlyApplicant();
  result.value = reply.result;
}

function onlyApplicant() {
  checked.value = roster.value.filter(({ isSelf }) => isSelf).map(({ id }) => id);
}

async function savePeople() {
  await request({ type: 'savePeople', people: roster.value.map((person) => ({ ...person })) }, '保存人员名册');
}

function remove(id: string) {
  roster.value = roster.value.filter((person) => person.id !== id);
  checked.value = checked.value.filter((value) => value !== id);
  void savePeople();
}

async function readPeople() {
  const { peopleInForm } = await request({ type: 'readPeople' });
  if (!peopleInForm) return;
  const read = peopleInForm.filter(({ isSelf }) => !isSelf);
  const ids = read.map(({ id }) => id);
  roster.value = [...roster.value.filter(({ isSelf }) => isSelf), ...read,
    ...roster.value.filter(({ id, isSelf }) => !isSelf && !ids.includes(id))].slice(0, 21);
  checked.value = [...new Set([...checked.value, ...ids])];
  if (!checked.value.length) onlyApplicant();
  peopleOpen.value = true;
  await savePeople();
}

async function prepare() {
  preview.value = undefined;
  if (!checked.value.length || !selected.value.length || !entries.value.length) {
    error.value = '请选择用餐人员和补贴类型';
    return;
  }
  const revision = props.target.revision;
  const reply = await request({ type: 'preview', input: input.value }, '核对 OA 误餐明细');
  if (props.visible && props.target.revision === revision) preview.value = reply.preview;
}

async function fill() {
  if (!preview.value) return;
  const { token } = preview.value;
  preview.value = undefined;
  result.value = undefined;
  const reply = await request({ type: 'fill', token, input: input.value }, '填写并回读 OA');
  if (reply.result) result.value = reply.result;
  if (reply.result?.clearApplied) clearFirst.value = false;
}
</script>
