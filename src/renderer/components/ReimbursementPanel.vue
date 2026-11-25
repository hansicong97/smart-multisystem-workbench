<template>
  <div class="reimb-panel">
    <div v-show="!reviewMode" class="reimb-body">
      <h3>差旅报销</h3>
      <p v-if="!reviewMode && error" class="reimb-alert" role="alert">{{ error }}</p>
      <p v-else-if="!reviewMode && notice" class="reimb-notice" role="status">{{ notice }}</p>
      <div v-if="state?.progress" class="reimb-progress" role="status">
        <span>{{ state.progress.label }}{{ state.progress.total ? ' ' + state.progress.done + ' / ' + state.progress.total : '' }}</span>
        <progress :max="state.progress.total || 1" :value="state.progress.total ? state.progress.done : undefined" />
        <button v-if="fileJob" type="button" class="reimb-button" @click="run({ type: 'cancel' })">取消</button>
      </div>
      <div v-if="state && !state.input" class="reimb-intake">
        <p class="reimb-muted">可同时选择发票 PDF 和含 PDF 的 ZIP。</p>
        <button type="button" class="reimb-button reimb-primary" :disabled="busy" @click="importFiles">选择发票文件</button>
        <button type="button" class="reimb-button" :disabled="busy" @click="run({ type: 'importCsv' })">
          导入 SM-ISA 已复核清单
        </button>
      </div>
      <template v-else-if="state">
        <div class="reimb-overview">
          <span v-if="state.input === 'files'">
            <strong>{{ state.sources.length }} 份 PDF</strong><small>{{ reviewed }} / {{ reviewable }} 项已复核</small>
          </span>
          <span v-else><strong>SM-ISA 已复核清单</strong><small>{{ state.expenses.length }} 条费用</small></span>
          <button v-if="state.input === 'files' && state.records.length" ref="reviewEntry" type="button" class="reimb-button" :disabled="busy"
            @click="reviewMode = 'original'">查看原件</button>
        </div>
        <details v-if="state.issues.length" class="reimb-issues" :open="state.issues.some((issue) => issue.kind === 'failed' && !issue.excluded)">
          <summary>导入结果（{{ state.issues.length }}）</summary>
          <ul>
            <li v-for="issue in state.issues" :key="issue.id">
              <strong>{{ issue.label }}</strong>
              <small>{{ issue.message }}{{ issue.excluded ? ' · 已排除' : '' }}</small>
              <button v-if="issue.kind === 'failed'" type="button" class="reimb-button" :disabled="busy"
                @click="run({ type: 'dismissIssue', id: issue.id, excluded: !issue.excluded })">
                {{ issue.excluded ? '取消排除' : '排除此项' }}
              </button>
            </li>
          </ul>
        </details>
        <div v-if="state.blockers.length" class="reimb-check">
          <strong>填写前请处理</strong>
          <ul><li v-for="item in state.blockers" :key="item">{{ item }}</li></ul>
        </div>

        <template v-if="!state.blockers.length">
          <label class="reimb-tax">
            <input v-model="includeTax" type="checkbox" :disabled="busy" @change="hidePreview = true">
            本次填写已知税额
          </label>
          <button type="button" class="reimb-button reimb-primary" :disabled="busy" @click="preview">
            预览 OA 填写
          </button>
          <div v-if="activePreview" class="reimb-check">
            <div class="reimb-overview">
              <span><strong>{{ activePreview.document }}</strong><small>账号 {{ activePreview.account }}</small></span>
              <strong>¥{{ activePreview.total }}</strong>
            </div>
            <p>{{ newCount }} 条待新增 · {{ matched }} 条已匹配 · {{ conflicts }} 条冲突</p>
            <p v-for="item in activePreview.entries.filter((entry) => entry.reason)" :key="item.expenseId" class="reimb-diff">
              第 {{ expenseOrdinal(item.expenseId) }} 条 · {{ item.reason }}
            </p>
            <button type="button" class="reimb-button reimb-primary" :disabled="busy || conflicts > 0"
              @click="run({ type: 'fill', token: activePreview.token, includeTax })">确认填写</button>
          </div>
          <div v-if="state.result" class="reimb-check" role="status">
            <strong>{{ state.result.message }}</strong>
            <p>已新增 {{ state.result.filled }} 条 · 已匹配 {{ state.result.matched }} 条 · 待处理 {{ state.result.remaining }} 条</p>
            <p v-if="state.result.readRows.length">已回读费用第 {{ state.result.readRows.join('、') }} 条</p>
            <p v-if="state.result.pendingRows.length">待处理费用第 {{ state.result.pendingRows.join('、') }} 条</p>
          </div>
          <details v-if="state.expenses.length" class="reimb-attachments" open>
            <summary>费用与待挂附件（{{ state.expenses.length }} 条）</summary>
            <ol>
              <li v-for="expense in state.expenses" :key="expense.id">
                <div class="reimb-expense">
                  <strong>{{ expense.minor }}</strong><span>¥{{ expense.amount }}</span>
                </div>
                <small>{{ expense.date }} · {{ expense.actualDateSource }}{{ expense.invoiceNumber ? ' · ' + expense.invoiceNumber : '' }}</small>
                <ul v-if="expense.attachments.length" class="reimb-file-list">
                  <li v-for="file in expense.attachments" :key="file.sourceId + ':' + file.page">
                    <button type="button" class="reimb-button reimb-file" :title="location(file.sourceId)"
                      @click="run({ type: 'savePdf', sourceId: file.sourceId })">
                      保存 {{ name(file.sourceId) }}
                    </button>
                    <small>{{ file.role === 'original' ? '发票原件' : '支持附件' }} · 第 {{ file.page }} 页</small>
                  </li>
                </ul>
              </li>
            </ol>
          </details>
        </template>
        <div class="reimb-actions">
          <button v-if="!clearPrompt" type="button" class="reimb-button" :disabled="busy" @click="clearPrompt = true">清空批次</button>
          <template v-else>
            <button type="button" class="reimb-button" :disabled="busy" @click="clear">确认清空本地批次</button>
            <button type="button" class="reimb-button" @click="clearPrompt = false">取消</button>
          </template>
        </div>
      </template>
    </div>

    <section v-if="state?.input === 'files' && state.records.length" v-show="reviewMode" class="reimb-document"
      role="dialog" aria-modal="true" aria-labelledby="reimb-document-heading">
      <header class="reimb-header">
        <div>
          <h2 id="reimb-document-heading" tabindex="-1" data-review-heading>{{ reviewMode === 'original' ? '票据原件' : '发票复核' }}</h2>
          <small>当前 OA 差旅报销单</small>
        </div>
        <button type="button" class="icon-button" aria-label="关闭票据窗口" title="关闭票据窗口" @click="returnToOa">
          <AppIcon name="close" />
        </button>
      </header>
      <p v-if="reviewMode && error" class="reimb-alert" role="alert">{{ error }}</p>
      <p v-else-if="reviewMode && notice" class="reimb-notice" role="status">{{ notice }}</p>
      <ReimbursementReview ref="review" :state="state" :visible="visible && !!reviewMode"
        :editing="reviewMode === 'review'" :run="run" />
      <footer class="reimb-footer reimb-actions">
        <button type="button" class="reimb-button" @click="returnToOa">返回单据</button>
        <button v-if="reviewMode === 'original'" type="button" class="reimb-button reimb-primary" @click="enterReview">进入复核</button>
        <button v-else type="button" class="reimb-button reimb-primary" @click="finishReview">完成复核</button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import type { PageAssistant } from '../../shared/assistant.js';
import type { ReimbursementCommand, ReimbursementReply, ReimbursementState } from '../../shared/reimbursement.js';
import AppIcon from './AppIcon.vue';
import ReimbursementReview from './ReimbursementReview.vue';

const props = defineProps<{ visible: boolean; target: PageAssistant }>();
const api = window.workbench;
const reviewMode = defineModel<'original' | 'review' | null>('reviewMode', { required: true });
const state = ref<ReimbursementState>();
const review = ref<InstanceType<typeof ReimbursementReview>>();
const reviewEntry = ref<HTMLButtonElement>();
const error = ref('');
const notice = ref('');
const clearPrompt = ref(false);
const includeTax = ref(false);
const hidePreview = ref(false);
const busy = computed(() => !!state.value?.progress);
const fileJob = computed(() => /选择报销材料|读取并识别发票材料|核验清单/u.test(state.value?.progress?.label ?? ''));
const reviewed = computed(() => state.value?.records.filter(({ status }) => status === 'reviewed').length ?? 0);
const reviewable = computed(() => state.value?.records.filter(({ status }) => status !== 'excluded').length ?? 0);
const activePreview = computed(() => !hidePreview.value && state.value?.preview?.pageId === props.target.pageId ? state.value?.preview : null);
const newCount = computed(() => activePreview.value?.entries.filter(({ status }) => status === 'new').length ?? 0);
const matched = computed(() => activePreview.value?.entries.filter(({ status }) => status === 'matched').length ?? 0);
const conflicts = computed(() => activePreview.value?.entries.filter(({ status }) => status === 'conflict').length ?? 0);

function source(id: string) { return state.value?.sources.find((item) => item.id === id); }
function name(id: string) { return source(id)?.name ?? 'PDF 附件'; }
function location(id: string) { return source(id)?.locations[0] ?? ''; }
function expenseOrdinal(id: string) { return (state.value?.expenses.findIndex((expense) => expense.id === id) ?? -1) + 1; }

async function run(command: ReimbursementCommand): Promise<ReimbursementReply> {
  const feedback = command.type !== 'pageImage';
  if (feedback) { error.value = ''; notice.value = ''; }
  try {
    if (!api) throw new Error();
    const reply = await api.reimbursement({ target: props.target, command });
    if (reply.state) state.value = reply.state;
    if (reply.error && feedback) error.value = reply.error;
    if (reply.saved) notice.value = '已保存 PDF 附件，可在 OA 选择该文件';
    return reply;
  } catch {
    const message = '无法完成报销操作，请重试';
    if (feedback) error.value = message;
    return { error: message };
  }
}

let active = true;
onActivated(() => { active = true; });
onDeactivated(() => { active = false; });

async function importFiles() {
  const revision = props.target.revision;
  const reply = await run({ type: 'importFiles' });
  if (reply.state?.records.length && active && props.visible && props.target.revision === revision) reviewMode.value = 'original';
}

async function preview() {
  await run({ type: 'preview', includeTax: includeTax.value });
  hidePreview.value = false;
}

async function returnToOa() {
  if (review.value && !await review.value.saveDraft()) return;
  reviewMode.value = null;
  await nextTick();
  reviewEntry.value?.focus({ preventScroll: true });
}

async function enterReview() {
  reviewMode.value = 'review';
  await nextTick();
  reviewEntry.value?.ownerDocument.querySelector<HTMLElement>('[data-review-heading]')?.focus();
}

async function finishReview() {
  if (review.value && !await review.value.saveDraft()) return;
  if (state.value?.records.some(({ status }) => status === 'pending')) {
    error.value = '请确认复核或排除待处理票据';
    return;
  }
  await returnToOa();
}

async function clear() {
  const reply = await run({ type: 'clear' });
  if (reply.error) return;
  reviewMode.value = null;
  clearPrompt.value = false;
}

watch(() => props.target.revision, () => {
  hidePreview.value = true;
  if (props.visible) void run({ type: 'state' });
});
watch(() => props.visible, (visible) => {
  hidePreview.value = true;
  if (visible) void run({ type: 'state' });
});
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  if (!api) return;
  unsubscribe = api.onReimbursementState((documentKey, value) => {
    if (documentKey === props.target.documentKey) state.value = value;
  });
  if (props.visible) void run({ type: 'state' });
});
onBeforeUnmount(() => unsubscribe?.());
defineExpose({ returnToOa });
</script>
