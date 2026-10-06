export const DISPLAY_WIDTH = 212;
export const DISPLAY_HEIGHT = 104;
export const BUFFER_SIZE = (DISPLAY_WIDTH * DISPLAY_HEIGHT) / 8;

export type Dithering = "none" | "ordered" | "floyd-steinberg" | "atkinson";

export type ImageSettings = {
  brightness: number;
  contrast: number;
  dithering: Dithering;
  strength: number;
  // Gray level (0–255) below which a pixel turns black; ordered dithering ignores it.
  threshold: number;
};

export const defaultSettings: ImageSettings = {
  brightness: 100,
  contrast: 100,
  dithering: "none",
  strength: 1,
  threshold: 128,
};

// Error-diffusion neighbours as [dx, dy, weight].
const KERNELS: Record<"floyd-steinberg" | "atkinson", number[][]> = {
  "floyd-steinberg": [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16],
  ],
  // Spreads only 6/8 of the error, which keeps edges and highlights crisp.
  atkinson: [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ],
};
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// Keep the original tool's portrait rotation and square-image containment.
export function resizeImage(image: ImageBitmap): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = DISPLAY_WIDTH;
  canvas.height = DISPLAY_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const rotate = image.height > image.width;
  const width = rotate ? image.height : image.width;
  const height = rotate ? image.width : image.height;
  const ratio = width / height;
  const scale =
    ratio > 0.8 && ratio < 1.25
      ? Math.min(canvas.width / width, canvas.height / height) * 0.92
      : Math.max(canvas.width / width, canvas.height / height);
  const dw = Math.round(width * scale);
  const dh = Math.round(height * scale);
  if (rotate) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(image, -dh / 2, -dw / 2, dh, dw);
  } else {
    ctx.drawImage(
      image,
      Math.floor((canvas.width - dw) / 2),
      Math.floor((canvas.height - dh) / 2),
      dw,
      dh,
    );
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function convertImage(
  pixels: Uint8ClampedArray,
  settings: ImageSettings,
): Uint8Array {
  const adjust = (value: number) =>
    Math.max(
      0,
      Math.min(
        255,
        (Math.round(((value - 128) * settings.contrast) / 100 + 128) *
          settings.brightness) /
          100,
      ),
    );
  const gray = new Float32Array(DISPLAY_WIDTH * DISPLAY_HEIGHT);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(
      0.299 * adjust(pixels[i * 4]) +
        0.587 * adjust(pixels[i * 4 + 1]) +
        0.114 * adjust(pixels[i * 4 + 2]),
    );
  }
  const kernel =
    settings.dithering === "floyd-steinberg" ||
    settings.dithering === "atkinson"
      ? KERNELS[settings.dithering]
      : null;
  const buffer = new Uint8Array(BUFFER_SIZE).fill(0xff);
  for (let y = 0; y < DISPLAY_HEIGHT; y++) {
    for (let x = 0; x < DISPLAY_WIDTH; x++) {
      const value = gray[y * DISPLAY_WIDTH + x];
      const threshold =
        settings.dithering === "ordered"
          ? (BAYER[y % 4][x % 4] / 16) * 255 * settings.strength
          : settings.threshold;
      const color = value < threshold ? 0 : 255;
      // Preserve the firmware's transposed 104 × 212, MSB-first buffer.
      if (color === 0) buffer[x * 13 + Math.floor(y / 8)] &= ~(0x80 >> (y % 8));
      if (!kernel) continue;
      const error = (value - color) * settings.strength;
      for (const [dx, dy, weight] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= DISPLAY_WIDTH || ny >= DISPLAY_HEIGHT) continue;
        const n = ny * DISPLAY_WIDTH + nx;
        gray[n] = Math.max(0, Math.min(255, gray[n] + error * weight));
      }
    }
  }
  return buffer;
}

export function previewPixels(buffer: Uint8Array) {
  const pixels = new Uint8ClampedArray(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
  for (let x = 0; x < DISPLAY_WIDTH; x++) {
    for (let y = 0; y < DISPLAY_HEIGHT; y++) {
      const color =
        buffer[x * 13 + Math.floor(y / 8)] & (0x80 >> (y % 8)) ? 255 : 0;
      const i = (y * DISPLAY_WIDTH + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = color;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}
