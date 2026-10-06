import { describe, expect, it } from "vitest";
import {
  convertImage,
  defaultSettings,
  previewPixels,
  type ImageSettings,
} from "./image";

function solid(gray: number) {
  const pixels = new Uint8ClampedArray(212 * 104 * 4);
  for (let i = 0; i < pixels.length; i += 4)
    pixels.set([gray, gray, gray, 255], i);
  return pixels;
}

describe("firmware bitmap layout", () => {
  it("transposes asymmetric pixels into MSB-first panel bytes across a byte boundary", () => {
    const pixels = solid(255);
    for (const [x, y] of [
      [3, 7],
      [5, 8],
      [211, 103],
    ])
      pixels.set([0, 0, 0, 255], (y * 212 + x) * 4);
    const expected = new Uint8Array(2756).fill(255);
    expected[39] = 0xfe;
    expected[66] = 0x7f;
    expected[2755] = 0xfe;
    expect(convertImage(pixels, defaultSettings)).toEqual(expected);
  });

  it("decodes known panel bytes independently of the encoder", () => {
    const buffer = new Uint8Array(2756).fill(255);
    buffer[27] = 0xbf;
    const pixels = previewPixels(buffer);
    expect(
      Array.from(pixels.slice((9 * 212 + 2) * 4, (9 * 212 + 2) * 4 + 4)),
    ).toEqual([0, 0, 0, 255]);
    expect(pixels[(2 * 212 + 9) * 4]).toBe(255);
  });

  it("preserves the black/white threshold and adjustment boundaries", () => {
    expect(
      convertImage(solid(127), defaultSettings).every((byte) => byte === 0),
    ).toBe(true);
    expect(
      convertImage(solid(128), defaultSettings).every((byte) => byte === 255),
    ).toBe(true);
    expect(
      convertImage(solid(255), { ...defaultSettings, brightness: 0 }).every(
        (byte) => byte === 0,
      ),
    ).toBe(true);
    expect(
      convertImage(solid(40), { ...defaultSettings, contrast: 0 }).every(
        (byte) => byte === 255,
      ),
    ).toBe(true);
  });

  it("distinguishes ordered dithering from diffusion and no dithering", () => {
    const pixels = solid(100);
    const ordered = previewPixels(
      convertImage(pixels, { ...defaultSettings, dithering: "ordered" }),
    );
    expect([ordered[0], ordered[4], ordered[212 * 4]]).toEqual([255, 0, 0]);
    const floyd = previewPixels(
      convertImage(pixels, {
        ...defaultSettings,
        dithering: "floyd-steinberg",
      }),
    );
    expect([floyd[0], floyd[4]]).toEqual([0, 255]);
    const none = previewPixels(convertImage(pixels, defaultSettings));
    expect([none[0], none[4]]).toEqual([0, 0]);
  });

  it("thresholds luminance, not the red channel, at the chosen level", () => {
    const red = new Uint8ClampedArray(212 * 104 * 4);
    for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
    // Pure red has luminance 76, so it is black at the default threshold.
    expect(convertImage(red, defaultSettings).every((byte) => byte === 0)).toBe(
      true,
    );
    expect(
      convertImage(solid(100), { ...defaultSettings, threshold: 90 }).every(
        (byte) => byte === 255,
      ),
    ).toBe(true);
    expect(
      convertImage(solid(100), { ...defaultSettings, threshold: 110 }).every(
        (byte) => byte === 0,
      ),
    ).toBe(true);
  });

  it("dithers with Atkinson, keeping solid areas solid", () => {
    const atkinson: ImageSettings = {
      ...defaultSettings,
      dithering: "atkinson",
    };
    expect(convertImage(solid(0), atkinson).every((byte) => byte === 0)).toBe(
      true,
    );
    expect(
      convertImage(solid(255), atkinson).every((byte) => byte === 255),
    ).toBe(true);
    const mid = previewPixels(convertImage(solid(100), atkinson));
    // Black first pixel; its error (100 × 1/8 each) lifts the next pixel to 112.5, still black.
    expect([mid[0], mid[4]]).toEqual([0, 0]);
    const black = mid.filter((value, i) => i % 4 === 0 && value === 0).length;
    expect(black).toBeGreaterThan(0);
    expect(black).toBeLessThan(212 * 104);
    expect(convertImage(solid(100), atkinson)).not.toEqual(
      convertImage(solid(100), {
        ...defaultSettings,
        dithering: "floyd-steinberg",
      }),
    );
  });
});
