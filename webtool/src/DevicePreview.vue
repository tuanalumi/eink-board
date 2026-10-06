<script setup lang="ts">
import { ref, watchEffect } from "vue";
import { DISPLAY_WIDTH, DISPLAY_HEIGHT, previewPixels } from "./image";
import type { Mode } from "./useBoard";
import clockSketch from "./previews/clock.svg";
import calendarSketch from "./previews/calendar.svg";
import calendarAnalogSketch from "./previews/calendar-analog.svg";

const props = defineProps<{
  mode: Mode;
  buffer: Uint8Array | null;
  // Pre-dithering 212×104 pixels; shown instead of the buffer when set.
  original?: ImageData | null;
}>();
// Static sketches of the firmware layouts with sample data, not live renders.
const sketches = {
  clock: clockSketch,
  calendar: calendarSketch,
  calendarAnalog: calendarAnalogSketch,
};
const canvas = ref<HTMLCanvasElement | null>(null);
watchEffect(() => {
  if (props.mode !== "image" || !props.buffer || !canvas.value) return;
  const pixels =
    props.original ??
    new ImageData(previewPixels(props.buffer), DISPLAY_WIDTH, DISPLAY_HEIGHT);
  canvas.value.getContext("2d")?.putImageData(pixels, 0, 0);
});
</script>

<template>
  <div
    class="flex aspect-212/104 w-full items-center justify-center overflow-hidden border border-neutral bg-[#f1f0e6] text-neutral"
  >
    <img
      v-if="mode !== 'image'"
      class="size-full object-contain"
      :src="sketches[mode]"
      alt="Sample layout of the firmware page"
    />
    <canvas
      v-else-if="buffer"
      ref="canvas"
      class="size-full"
      :width="DISPLAY_WIDTH"
      :height="DISPLAY_HEIGHT"
      aria-label="Processed monochrome image"
    />
    <span v-else class="text-sm opacity-60">No image loaded</span>
  </div>
</template>
