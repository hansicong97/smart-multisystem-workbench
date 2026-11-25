<template>
  <section class="reimb-review" :class="{ 'reimb-original-only': !editing }" :aria-label="editing ? '发票复核内容' : '发票原件'">
    <nav class="reimb-records" aria-label="票据列表">
      <h3>票据（{{ state.records.length }}）</h3>
      <button v-for="record in state.records" :key="record.id" type="button" class="reimb-record"
        :aria-current="record.id === selectedId ? 'true' : undefined" :disabled="busy" @click="choose(record.id)">
        <strong>{{ record.fields.kind === 'support' ? '支持附件' : record.fields.category || '待分类票据' }}</strong>
        <span :title="location(record.sourceId)">{{ location(record.sourceId) }} · 第 {{ record.page }} 页</span>
        <small>{{ statusLabel[record.status] }}</small>
      </button>
      <p v-if="!state.records.length" class="reimb-muted">本批次没有可复核的 PDF。</p>
    </nav>

    <div v-if="selected && draft" class="reimb-detail">
      <div class="reimb-origin">
        <div class="reimb-origin-title" :title="location(selected.sourceId)">{{ location(selected.sourceId) }}</div>
        <span v-if="source && source.locations.length > 1" class="reimb-muted" :title="source.locations.join('\n')">
          {{ source.locations.length }} 处来源，PDF 内容相同
        </span>
        <div class="reimb-actions">
          <button type="button" class="reimb-button" :disabled="page <= 1" @click="page -= 1">上一页</button>
          <span class="reimb-page">第 {{ page }}{{ image ? ' / ' + image.pages : '' }} 页</span>
          <button type="button" class="reimb-button" :disabled="!image || page >= image.pages" @click="page += 1">下一页</button>
          <button type="button" class="reimb-button" @click="run({ type: 'savePdf', sourceId: selected.sourceId })">保存 PDF 附件</button>
        </div>
        <div class="reimb-paper">
          <img v-if="image" :src="'data:image/png;base64,' + image.png" :alt="'发票原件第 ' + page + ' 页'">
          <p v-else role="status">{{ imageError || '正在读取原件…' }}</p>
        </div>
      </div>

      <form v-show="editing" class="reimb-editor" @submit.prevent="save(true)">
        <ul v-if="selected.warnings.length" class="reimb-warnings">
          <li v-for="warning in selected.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <fieldset :disabled="busy || selected.status === 'excluded'">
          <label>材料用途
            <select v-model="draft.kind">
              <option value="expense">费用票据</option><option value="support">支持附件</option>
            </select>
          </label>
          <template v-if="draft.kind === 'expense'">
            <label>票据分类
              <select v-model="draft.category" @change="categoryChanged">
                <option value="">请选择</option>
                <option v-for="category in EXPENSE_CATEGORIES" :key="category">{{ category }}</option>
              </select>
            </label>
            <label>费用小类
              <select v-model="draft.minor">
                <option value="">请选择</option>
                <option v-for="minor in minors" :key="minor">{{ minor }}</option>
              </select>
            </label>
            <label>发票类型
              <select v-model="draft.invoiceType">
                <option value="">请选择</option>
                <option v-for="type in INVOICE_TYPES" :key="type">{{ type }}</option>
              </select>
            </label>
            <label>发票号码 <input v-model.trim="draft.invoiceNumber" maxlength="24" inputmode="numeric"></label>
            <label>发票代码 <input v-model.trim="draft.invoiceCode" maxlength="12" inputmode="numeric"></label>
            <label>价税合计 <input v-model.trim="draft.amount" maxlength="17" inputmode="decimal"></label>
            <label>税额 <input v-model.trim="draft.tax" maxlength="17" inputmode="decimal" placeholder="未列示时留空"></label>
            <label>开票日期 <input v-model="draft.invoiceDate" type="date"></label>
            <label>乘坐日期 <input v-model="draft.travelStart" type="date"></label>
            <label>出差结束日期 <input v-model="draft.travelEnd" type="date"></label>
            <label>OA 日期来源
              <select v-model="draft.dateSource">
                <option v-for="dateSource in DATE_SOURCES" :key="dateSource">{{ dateSource }}</option>
              </select>
            </label>
            <label v-if="draft.dateSource === '手动日期'">手动日期 <input v-model="draft.manualDate" type="date"></label>
            <label class="reimb-wide">OA 摘要 <textarea v-model="draft.summary" rows="2" maxlength="500"></textarea></label>
          </template>
          <label v-else class="reimb-wide">关联费用
            <select v-model="draft.linkedExpense">
              <option value="">请选择要挂载的明细</option>
              <option v-for="record in linkable" :key="record.id" :value="record.id">
                {{ record.fields.category || '待分类' }} · {{ location(record.sourceId) }} · 第 {{ record.page }} 页
              </option>
            </select>
          </label>
          <label class="reimb-wide">复核备注 <textarea v-model="draft.note" maxlength="1000" rows="2"></textarea></label>
        </fieldset>
        <div class="reimb-actions">
          <button v-if="selected.status !== 'excluded'" type="submit" class="reimb-button reimb-primary" :disabled="busy">确认复核</button>
          <button v-if="selected.status !== 'excluded'" type="button" class="reimb-button" :disabled="busy || !dirty"
            @click="save(false)">保存修改</button>
          <button type="button" class="reimb-button" :disabled="busy" @click="exclude">
            {{ selected.status === 'excluded' ? '取消排除' : '排除此页' }}
          </button>
        </div>
      </form>
    </div>
    <p v-else class="reimb-muted">请选择票据，或返回助手查看导入问题。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CATEGORY_MINORS, DATE_SOURCES, EXPENSE_CATEGORIES, INVOICE_TYPES } from '../../shared/reimbursement.js';
import type { InvoiceFields, ReimbursementCommand, ReimbursementReply, ReimbursementState } from '../../shared/reimbursement.js';

const props = defineProps<{
  state: ReimbursementState;
  visible: boolean;
  editing: boolean;
  run: (command: ReimbursementCommand) => Promise<ReimbursementReply>;
}>();
const statusLabel = { pending: '待复核', reviewed: '已复核', excluded: '已排除' };
const selectedId = ref('');
const selected = computed(() => props.state.records.find(({ id }) => id === selectedId.value));
const source = computed(() => props.state.sources.find(({ id }) => id === selected.value?.sourceId));
const draft = ref<InvoiceFields>();
const saving = ref(false);
const busy = computed(() => saving.value || !!props.state.progress);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(selected.value?.fields));
const minors = computed(() => draft.value?.category ? CATEGORY_MINORS[draft.value.category] : []);
const linkable = computed(() => props.state.records.filter(({ sourceId, fields, status }) =>
  sourceId !== selected.value?.sourceId && fields.kind === 'expense' && status !== 'excluded'));
const page = ref(1);
const image = ref<ReimbursementReply['image']>();
const imageError = ref('');

function location(id: string) {
  return props.state.sources.find((item) => item.id === id)?.locations[0] ?? 'PDF 原件';
}

watch(() => props.state.records, (records) => {
  if (!records.some(({ id }) => id === selectedId.value)) selectedId.value = records[0]?.id ?? '';
}, { immediate: true });
watch(() => selected.value?.id, () => {
  draft.value = selected.value ? { ...selected.value.fields } : undefined;
  page.value = selected.value?.page ?? 1;
}, { immediate: true });

watch([() => source.value?.id, page, () => props.visible], async ([id, number, visible], _previous, invalidate) => {
  if (!id || !visible) return;
  let current = true;
  invalidate(() => { current = false; });
  image.value = undefined;
  imageError.value = '';
  try {
    const reply = await props.run({ type: 'pageImage', sourceId: id, page: number });
    if (!current) return;
    image.value = reply.image;
    imageError.value = reply.error ?? '原件预览不可用';
  } catch {
    if (current) imageError.value = '原件预览不可用';
  }
}, { immediate: true });

function categoryChanged() {
  if (!draft.value) return;
  if (!minors.value.some((minor) => minor === draft.value?.minor)) draft.value.minor = minors.value.length === 1 ? minors.value[0] : '';
}

async function save(review: boolean): Promise<boolean> {
  if (!draft.value || !selected.value || busy.value) return false;
  saving.value = true;
  try {
    if (dirty.value) {
      const result = await props.run({ type: 'edit', id: selected.value.id, fields: { ...draft.value } });
      if (result.error) return false;
    }
    if (review) return !(await props.run({ type: 'review', id: selected.value.id })).error;
    return true;
  } finally {
    saving.value = false;
  }
}

async function choose(id: string) {
  if (dirty.value && !(await save(false))) return;
  selectedId.value = id;
}

async function exclude() {
  if (!selected.value) return;
  const record = selected.value;
  await props.run({ type: 'exclude', id: record.id, excluded: record.status !== 'excluded' });
  draft.value = { ...record.fields };
}

defineExpose({ saveDraft: () => dirty.value ? save(false) : Promise.resolve(true) });
</script>
