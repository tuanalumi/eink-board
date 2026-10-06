<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  shallowRef,
  watchEffect,
} from "vue";
import DevicePreview from "./DevicePreview.vue";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  convertImage,
  defaultSettings,
  resizeImage,
  type ImageSettings,
} from "./image";
import { modes, useBoard, type Mode } from "./useBoard";

const modeLabels: Record<Mode, string> = {
  clock: "Clock",
  calendar: "Calendar",
  calendarAnalog: "Analog calendar",
  image: "Image",
};
const selectedMode = ref<Mode>("clock");
const now = ref(new Date());
const {
  connected,
  connecting,
  connectionStage,
  bluetoothAvailable,
  deviceName,
  busy,
  progress,
  logs,
  error,
  log,
  connect,
  cancelConnection,
  disconnect,
  applyMode,
  syncTime,
  refreshDisplay,
  uploadImage,
} = useBoard();
const locked = computed(() => !!busy.value || connecting.value);
const canSend = computed(() => connected.value && !locked.value);
const status = computed(() => {
  const state = connected.value
    ? "Connected"
    : connecting.value
      ? "Connecting"
      : "Not connected";
  return `${deviceName.value ? `${deviceName.value} · ` : ""}${state}`;
});
const imageFile = shallowRef<File | null>(null);
const source = shallowRef<ImageData | null>(null);
const imageBuffer = shallowRef<Uint8Array | null>(null);
const imageLoading = ref(false);
const dragging = ref(false);
const showOriginal = ref(false);
const settings = reactive<ImageSettings>({ ...defaultSettings });
let imageVersion = 0;
const computerTime = computed(() => now.value.toLocaleTimeString("en-GB"));
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
watchEffect(() => {
  imageBuffer.value = source.value
    ? convertImage(source.value.data, settings)
    : null;
});
let clockTimer: ReturnType<typeof setInterval>;
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 1000);
});
onUnmounted(() => {
  clearInterval(clockTimer);
  imageVersion++;
});

async function loadImage(file?: File) {
  if (!file || locked.value) return;
  const version = ++imageVersion;
  imageLoading.value = true;
  error.value = "";
  try {
    const bitmap = await createImageBitmap(file);
    try {
      if (version !== imageVersion) return;
      source.value = resizeImage(bitmap);
      showOriginal.value = false;
      imageFile.value = file;
      progress.value = 0;
      log(`Image loaded: ${file.name} · ${bitmap.width} × ${bitmap.height}`);
    } finally {
      bitmap.close();
    }
  } catch (cause) {
    if (version === imageVersion)
      log(
        `Cannot decode image: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
  } finally {
    if (version === imageVersion) imageLoading.value = false;
  }
}
function onFileChange(event: Event) {
  if (event.target instanceof HTMLInputElement) {
    void loadImage(event.target.files?.[0]);
    event.target.value = "";
  }
}
// Picsum serves random Unsplash photos without an API key.
async function loadRandomImage() {
  if (locked.value || imageLoading.value) return;
  const version = imageVersion;
  imageLoading.value = true;
  try {
    const response = await fetch(
      `https://picsum.photos/${DISPLAY_WIDTH * 2}/${DISPLAY_HEIGHT * 2}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    // A file chosen or cleared meanwhile wins over the late download.
    if (version !== imageVersion) return;
    const id = response.headers.get("Picsum-Id") ?? "random";
    await loadImage(new File([blob], `picsum-${id}.jpg`, { type: blob.type }));
  } catch (cause) {
    if (version === imageVersion)
      log(
        `Cannot fetch random photo: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
  } finally {
    if (version === imageVersion) imageLoading.value = false;
  }
}
function onDrop(event: DragEvent) {
  dragging.value = false;
  void loadImage(event.dataTransfer?.files[0]);
}
function clearImage() {
  imageVersion++;
  imageFile.value = null;
  source.value = null;
  imageBuffer.value = null;
  imageLoading.value = false;
  progress.value = 0;
}
function copyLog() {
  void navigator.clipboard
    .writeText(
      logs.value.map((line) => `[${line.time}] ${line.message}`).join("\n"),
    )
    .then(() => log("Log copied."))
    .catch(() => log("Cannot copy log.", "error"));
}
</script>

<template>
  <main class="mx-auto flex max-w-5xl flex-col gap-4 p-4">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 class="text-xl font-semibold">E-ink board</h1>
      <p class="flex-1 text-sm" role="status">
        {{ status }}
        <span v-if="connecting && connectionStage" class="opacity-70">
          · {{ connectionStage }}
        </span>
      </p>
      <button
        v-if="!connected && !connecting && bluetoothAvailable"
        class="link text-sm"
        :disabled="locked"
        @click="connect(true)"
      >
        Scan all BLE devices
      </button>
      <button
        v-if="connecting && deviceName"
        class="btn btn-outline btn-sm"
        @click="cancelConnection"
      >
        Cancel
      </button>
      <button
        v-else-if="!connected"
        class="btn btn-primary btn-sm"
        :disabled="locked || !bluetoothAvailable"
        @click="connect()"
      >
        <span v-if="connecting" class="loading loading-spinner loading-xs" />
        Connect
      </button>
      <button
        v-else
        class="btn btn-outline btn-sm"
        :disabled="locked"
        @click="disconnect"
      >
        Disconnect
      </button>
    </header>

    <p v-if="!bluetoothAvailable" class="alert alert-warning py-2 text-sm">
      Web Bluetooth needs Chrome or Edge on HTTPS or localhost.
    </p>
    <div v-if="error" class="alert alert-error py-2 text-sm" role="alert">
      <span class="flex-1">{{ error }}</span>
      <button class="btn btn-ghost btn-xs" @click="error = ''">Dismiss</button>
    </div>
    <p v-if="busy" class="flex items-center gap-2 text-sm" role="status">
      <span class="loading loading-spinner loading-xs" />{{ busy }}
    </p>

    <div class="grid gap-4 md:grid-cols-2">
      <section class="card card-border bg-base-100">
        <div class="card-body gap-3 p-4">
          <h2 class="card-title text-base">Display</h2>
          <div class="join w-full">
            <button
              v-for="mode in modes"
              :key="mode"
              class="btn btn-sm join-item flex-1 px-1"
              :class="{ 'btn-primary': selectedMode === mode }"
              :aria-pressed="selectedMode === mode"
              @click="selectedMode = mode"
            >
              {{ modeLabels[mode] }}
            </button>
          </div>
          <DevicePreview :mode="selectedMode" :buffer="imageBuffer" />
          <div class="flex flex-wrap items-center gap-2">
            <button
              class="btn btn-primary btn-sm"
              :disabled="!canSend"
              @click="applyMode(selectedMode)"
            >
              Apply mode
            </button>
            <button
              class="btn btn-outline btn-sm"
              :disabled="!canSend"
              @click="syncTime"
            >
              Sync time
            </button>
            <button
              class="btn btn-outline btn-sm"
              :disabled="!canSend"
              @click="refreshDisplay"
            >
              Full refresh
            </button>
          </div>
          <p class="text-xs opacity-70">
            Computer time: {{ computerTime }} · {{ timezone }}
          </p>
        </div>
      </section>

      <section class="card card-border bg-base-100">
        <div class="card-body gap-3 p-4">
          <h2 class="card-title text-base">Image</h2>
          <div class="flex gap-2">
            <input
              type="file"
              accept="image/*"
              class="file-input file-input-sm min-w-0 flex-1"
              aria-label="Choose image file"
              :disabled="locked"
              @change="onFileChange"
            />
            <button
              class="btn btn-outline btn-sm"
              :disabled="locked || imageLoading"
              @click="loadRandomImage"
            >
              Random photo
            </button>
          </div>
          <div
            class="rounded-field border border-dashed p-2"
            :class="dragging ? 'border-primary bg-base-200' : 'border-base-300'"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <button
              type="button"
              class="block w-full cursor-pointer disabled:cursor-default"
              :disabled="!imageBuffer"
              :aria-pressed="showOriginal"
              aria-label="Toggle original image"
              @click="showOriginal = !showOriginal"
            >
              <DevicePreview
                mode="image"
                :buffer="imageBuffer"
                :original="showOriginal ? source : null"
              />
            </button>
            <p class="mt-1 text-xs opacity-70">
              {{
                imageLoading
                  ? "Loading…"
                  : imageFile
                    ? `${imageFile.name} · ${showOriginal ? "original" : "processed"} (click to toggle)`
                    : "Drop an image here"
              }}
            </p>
          </div>
          <fieldset class="flex flex-col gap-2" :disabled="locked">
            <label class="flex items-center gap-2 text-sm">
              <span class="w-24">Brightness</span>
              <input
                v-model.number="settings.brightness"
                class="range range-primary range-xs flex-1"
                type="range"
                min="0"
                max="200"
              />
              <output class="w-10 text-right">{{ settings.brightness }}</output>
            </label>
            <label class="flex items-center gap-2 text-sm">
              <span class="w-24">Contrast</span>
              <input
                v-model.number="settings.contrast"
                class="range range-primary range-xs flex-1"
                type="range"
                min="0"
                max="200"
              />
              <output class="w-10 text-right">{{ settings.contrast }}</output>
            </label>
            <label class="flex items-center gap-2 text-sm">
              <span class="w-24">Dithering</span>
              <select
                v-model="settings.dithering"
                class="select select-sm flex-1"
              >
                <option value="none">None</option>
                <option value="ordered">Ordered</option>
                <option value="floyd-steinberg">Floyd–Steinberg</option>
                <option value="atkinson">Atkinson</option>
              </select>
            </label>
            <label
              v-if="settings.dithering !== 'ordered'"
              class="flex items-center gap-2 text-sm"
            >
              <span class="w-24">Threshold</span>
              <input
                v-model.number="settings.threshold"
                class="range range-primary range-xs flex-1"
                type="range"
                min="0"
                max="255"
              />
              <output class="w-10 text-right">{{ settings.threshold }}</output>
            </label>
            <label
              v-if="settings.dithering !== 'none'"
              class="flex items-center gap-2 text-sm"
            >
              <span class="w-24">Strength</span>
              <input
                v-model.number="settings.strength"
                class="range range-primary range-xs flex-1"
                type="range"
                min="0"
                max="2"
                step="0.1"
              />
              <output class="w-10 text-right">
                {{ settings.strength.toFixed(1) }}
              </output>
            </label>
          </fieldset>
          <div class="flex flex-wrap items-center gap-2">
            <button
              class="btn btn-primary btn-sm"
              :disabled="!canSend || !imageBuffer || imageLoading"
              @click="imageBuffer && uploadImage(imageBuffer)"
            >
              Upload &amp; save
            </button>
            <button
              class="btn btn-outline btn-sm"
              :disabled="locked || !imageFile"
              @click="clearImage"
            >
              Clear image
            </button>
            <progress
              class="progress progress-primary min-w-24 flex-1"
              :value="progress"
              max="100"
              aria-label="Upload progress"
            />
          </div>
        </div>
      </section>
    </div>

    <section class="card card-border bg-base-100">
      <div class="card-body gap-2 p-4">
        <div class="flex items-center gap-2">
          <h2 class="card-title flex-1 text-base">Activity log</h2>
          <button class="btn btn-ghost btn-xs" @click="copyLog">Copy</button>
          <button class="btn btn-ghost btn-xs" @click="logs = []">Clear</button>
        </div>
        <div
          class="max-h-48 overflow-y-auto font-mono text-xs"
          role="log"
          tabindex="0"
          aria-label="Device activity"
        >
          <p v-if="!logs.length" class="opacity-60">No activity yet.</p>
          <div
            v-for="(line, i) in logs.slice().reverse()"
            :key="logs.length - i"
            class="flex gap-2"
            :class="{ 'font-semibold text-error': line.level === 'error' }"
          >
            <time class="shrink-0 opacity-60">{{ line.time }}</time>
            <span class="break-words">{{ line.message }}</span>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>
