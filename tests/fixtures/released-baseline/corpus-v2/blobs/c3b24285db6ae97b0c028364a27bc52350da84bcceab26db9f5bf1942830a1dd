import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'stack'> & {
  npm: Pick<ResolvedGeneratorContext['npm'], 'frontend'>;
};
import type { AddArtifact } from '../../template-types.js';
import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { escapeHtml } from './values.js';
import { genAiPattern } from './values.js';
import { renderFrontendDockerfile } from '../containers/images.js';


import { scriptSourceString } from './values.js';
import { renderDockerignore } from '../containers/context.js';

export function addFrontendArtifacts(add: AddArtifact, plan: ApiProjectPlan, context: GeneratorContext): void {
  add('frontend-package', 'frontend', ['frontend', 'package.json'], renderFrontendPackage(plan, context));
  add('frontend-lock', 'frontend', ['frontend', 'package-lock.json'], context.npm["frontend"].lock);
  add('frontend-index', 'frontend', ['frontend', 'index.html'], renderFrontendIndex(plan));
  add('frontend-main', 'frontend', ['frontend', 'src', 'main.ts'], renderFrontendMain());
  add('frontend-app', 'frontend', ['frontend', 'src', 'App.vue'], renderFrontendApp(plan));
  add('frontend-env-example', 'frontend', ['frontend', '.env.example'], 'VITE_API_BASE_URL=http://localhost:8000');
  add('frontend-styles', 'frontend', ['frontend', 'src', 'styles.css'], renderFrontendStyles());
  add('frontend-vite-config', 'frontend', ['frontend', 'vite.config.ts'], renderFrontendViteConfig());
  add('frontend-tailwind-config', 'frontend', ['frontend', 'tailwind.config.ts'], renderFrontendTailwindConfig());
  add('frontend-dockerfile', 'frontend', ['frontend', 'Dockerfile'], renderFrontendDockerfile(context));
  add('frontend-dockerignore', 'frontend', ['frontend', '.dockerignore'], renderDockerignore());
}

export function renderFrontendPackage(plan: ApiProjectPlan, context: GeneratorContext): string {
  return context.npm["frontend"].package;
}

export function renderFrontendIndex(plan: ApiProjectPlan): string {
  return `<div id="app"></div><script type="module" src="/src/main.ts"></script><title>${escapeHtml(plan.projectName)}</title>`;
}

export function renderFrontendMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');
`;
}

export function renderFrontendApp(plan: ApiProjectPlan): string {
  const descriptor = plan.workload === 'genai'
    ? genAiPattern(plan).id === 'generic'
      ? genAiPattern(plan).label
      : `${genAiPattern(plan).label} starter`
    : `${plan.apiStack.label} starter`;
  const apiContract = plan.workload === 'standard'
    ? { route: '/api', method: 'GET', bodyField: '', queryParameter: '', requiresInput: false }
    : genAiPattern(plan).id === 'rag'
      ? { route: `${genAiPattern(plan).routePrefix}/query`, method: 'POST', bodyField: 'question', queryParameter: '', requiresInput: true }
      : genAiPattern(plan).id === 'streaming'
        ? { route: genAiPattern(plan).routePrefix, method: 'GET', bodyField: '', queryParameter: 'prompt', requiresInput: true }
        : { route: `${genAiPattern(plan).routePrefix}/run`, method: 'POST', bodyField: 'input', queryParameter: '', requiresInput: true };
  return `<script setup lang="ts">
import { ref } from 'vue';

const title = ${scriptSourceString(plan.projectName)};
const starter = ${scriptSourceString(plan.frontendStarter)};
const descriptor = ${scriptSourceString(descriptor)};
${plan.workload === 'genai' ? `const capability = ${scriptSourceString(`${plan.pattern.scaffoldStatus}: ${plan.pattern.description}`)};\n` : ''}
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\\/+$/, '');
const route = ${scriptSourceString(apiContract.route)};
const method = ${scriptSourceString(apiContract.method)};
const bodyField = ${scriptSourceString(apiContract.bodyField)};
const queryParameter = ${scriptSourceString(apiContract.queryParameter)};
const requiresInput = ${apiContract.requiresInput};

const input = ref('');
const loading = ref(false);
const result = ref('');
const errorMessage = ref('');

async function submit(): Promise<void> {
  const value = input.value.trim();
  if (requiresInput && !value) {
    errorMessage.value = 'Enter a value before running the starter.';
    return;
  }

  loading.value = true;
  result.value = '';
  errorMessage.value = '';
  try {
    const query = queryParameter
      ? '?' + queryParameter + '=' + encodeURIComponent(value)
      : '';
    const request: RequestInit = { method };
    if (method === 'POST') {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify({ [bodyField]: value });
    }
    const response = await fetch(apiBaseUrl + route + query, request);
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        'Backend request failed (' + response.status + '): ' +
        (responseText || response.statusText)
      );
    }
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      result.value = JSON.stringify(JSON.parse(responseText), null, 2);
    } else {
      result.value = responseText;
    }
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? error.message
      : 'The backend request failed unexpectedly.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 text-slate-950">
    <section class="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header>
        <p class="text-sm font-semibold uppercase tracking-wide text-emerald-700">Mission Control Liftoff</p>
        <h1 class="mt-2 text-3xl font-bold">{{ title }}</h1>
        <p class="mt-2 text-slate-600">{{ descriptor }}</p>
${plan.workload === 'genai' ? '        <p class="mt-2 text-sm text-slate-600">{{ capability }}</p>\n' : ''}
      </header>
      <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-xl font-semibold">{{ starter }}</h2>
        <p class="mt-2 text-sm text-slate-500">API: {{ apiBaseUrl }}{{ route }}</p>
        <textarea
          v-if="requiresInput"
          v-model="input"
          class="mt-4 min-h-40 w-full rounded-md border border-slate-300 p-3"
          :disabled="loading"
          placeholder="Enter input for the generated backend."
        />
        <button
          class="mt-4 rounded-md bg-emerald-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loading"
          type="button"
          @click="submit"
        >
          {{ loading ? 'Running...' : 'Run' }}
        </button>
        <p v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-3 text-red-800" role="alert">
          {{ errorMessage }}
        </p>
        <pre v-if="result" class="mt-4 overflow-auto rounded-md bg-slate-950 p-4 text-sm text-white" aria-live="polite">{{ result }}</pre>
      </section>
    </section>
  </main>
</template>
`;
}

export function renderFrontendStyles(): string {
  return `@import "tailwindcss";
`;
}

export function renderFrontendViteConfig(): string {
  return `import { defineConfig } from 'vite';
  import tailwindcss from '@tailwindcss/vite';
  import vue from '@vitejs/plugin-vue';

  export default defineConfig({ plugins: [vue(), tailwindcss()] });
`;
}

export function renderFrontendTailwindConfig(): string {
  return `import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
`;
}
