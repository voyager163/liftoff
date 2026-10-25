<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { createItem, isReady, listItems, type Item } from "./api";

const title = "{{liftoff.name}}";
const ready = ref<boolean>();
const items = ref<Item[]>([]);
const name = ref("");
const error = ref("");
const saving = ref(false);
const loading = ref(true);
const loadFailed = ref(false);
// Adding waits for the list, which would otherwise replace the new item if it
// arrived later, and for the previous add, so nothing is sent twice. Requests
// give up after a while, so neither can keep the form disabled for good.
const busy = computed(() => !ready.value || loading.value || saving.value);
const canRetry = computed(
  () => !loading.value && (ready.value === false || loadFailed.value),
);

async function load(): Promise<void> {
  loading.value = true;
  loadFailed.value = false;
  ready.value = undefined;
  ready.value = await isReady();
  if (ready.value) {
    try {
      items.value = await listItems();
      error.value = "";
    } catch (cause) {
      error.value = `Could not load the items: ${(cause as Error).message}`;
      loadFailed.value = true;
    }
  }
  loading.value = false;
}

async function add(): Promise<void> {
  const value = name.value.trim();
  if (value === "" || busy.value) return;
  saving.value = true;
  try {
    items.value.push(await createItem(value));
    name.value = "";
    error.value = "";
  } catch (cause) {
    error.value = `Could not add the item: ${(cause as Error).message}`;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="mx-auto max-w-xl space-y-6 p-6 text-slate-900">
    <header class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-semibold">{{ title }}</h1>
      <span v-if="ready === undefined" class="text-sm text-slate-500">
        Checking the API…
      </span>
      <span
        v-else-if="ready"
        class="rounded bg-green-100 px-2 py-1 text-sm text-green-800"
      >
        API ready
      </span>
      <span v-else class="rounded bg-red-100 px-2 py-1 text-sm text-red-800">
        API unavailable
      </span>
    </header>

    <form class="flex gap-2" @submit.prevent="add">
      <label class="sr-only" for="item-name">New item</label>
      <input
        id="item-name"
        v-model="name"
        class="flex-1 rounded border border-slate-300 px-3 py-2"
        maxlength="200"
        placeholder="New item"
        :disabled="!ready || loading"
      />
      <button
        type="submit"
        class="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
        :disabled="busy"
      >
        Add
      </button>
    </form>

    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <button
      v-if="canRetry"
      type="button"
      class="text-sm text-slate-700 underline"
      @click="load"
    >
      Try again
    </button>

    <ul class="divide-y divide-slate-200 rounded border border-slate-200">
      <li v-for="item in items" :key="item.id" class="px-3 py-2">
        {{ item.name }}
      </li>
      <li v-if="ready && items.length === 0" class="px-3 py-2 text-slate-500">
        No items yet.
      </li>
    </ul>
  </main>
</template>
