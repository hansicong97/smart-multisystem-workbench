<template>
  <section id="dashboard" class="dashboard" aria-labelledby="dashboard-title">
    <div class="intro">
      <h1 id="dashboard-title">工作台</h1>
      <p>选择应用，在当前窗口打开页面。</p>
    </div>
    <div id="cards" class="cards">
      <button
        v-for="entry in apps"
        :key="entry.id"
        class="card"
        type="button"
        :aria-label="`进入 ${entry.name}`"
        :disabled="!entry.configured"
        @click="openApp(entry.id)"
      >
        <span class="mark" :data-site="entry.id" aria-hidden="true">{{ entry.mark }}</span>
        <strong>{{ entry.name }}</strong>
        <span class="description">{{ entry.description }}</span>
        <span class="action">{{ cardAction(entry) }}</span>
      </button>
    </div>
    <p v-if="state?.configMessage" id="configuration" role="status">{{ state.configMessage }}</p>
  </section>
</template>

<script setup lang="ts">
import { useWorkbench } from '../store.js';

const { state, apps, openApp, cardAction } = useWorkbench();
</script>
