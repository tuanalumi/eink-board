# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Custom firmware and a browser configurator for a repurposed 2.13″ black/white e-paper price tag (212×104) driven by a Dialog/Renesas **DA14585** BLE SoC. The two halves talk over a custom BLE GATT protocol.

- `projects/target_apps/ble_examples/ble_app_ota/src/` — the firmware. It is a modified Dialog SDK 6.0.18 `ble_app_ota` example. Everything else at the top level (`sdk/`, `third_party/`, `utilities/`, `config/`, `doc/`) is vendor SDK code and docs.
- `webtool/` — Vue 3 + TypeScript + Vite + Tailwind 4 + daisyUI 5 web app that drives the board via Web Bluetooth.
- `CODEX_HANDOFF.md` — earlier research notes: the full BLE protocol tables, lunar-calendar findings, the Vietnamese font plan, and open questions. Read it before you change the protocol or the firmware.

## Webtool commands

Run these from `webtool/`. Node 22.12+. The root `package-lock.json`/`node_modules` are leftovers (`gh-pages` only) and are not part of the webtool.

```sh
npm ci
npm start                            # Vite dev server on 127.0.0.1:3000
npm test                             # vitest run (node env, no DOM)
npx vitest run src/image.test.ts     # one file
npx vitest run -t "partial name"     # one test by name
npm run build                        # vue-tsc --noEmit, then vite build → dist/
```

Web Bluetooth needs desktop Chrome or Edge, on HTTPS or localhost. The output uses `base: "./"`, so `dist/` can be served from a subdirectory.

## Firmware build

Builds use Keil uVision5 with SDK 6.0.18.1182.1. Flash over J-Link SWD, or update over the air with Dialog SUOTA. The `Keil_5/` project folder is **gitignored and not in this checkout**, so you cannot build the firmware from this repo as-is. `DA1458x_SUOTA_Multipart_Binary_Generator_v0.3/` (Python + Windows `.exe` tools) packages SUOTA images.

## Architecture: the protocol contract

The webtool and the firmware share implicit constants. Change both sides together.

- **GATT:** service `1f10`, control characteristic `1f1f`, data/image characteristic `1f11`. These are defined in `webtool/src/useBoard.ts`. The firmware handles them in `user_custs1_impl.c`, which has **two separate write handlers**, one per characteristic. Some opcodes (`AA`, `AB`) mean different things on each, and mode-select opcodes appear in both handlers.
- **Display modes:** the order of `display_mode_t` in `display_manager.h` must match the `modes` array in `useBoard.ts`. The `E1 <index>` value is the array index. The webtool deliberately omits the firmware's fabric-record mode (`E1 04`, `E6`, `F0` field writes). The owner does not use it and plans to drop it from their custom firmware. Do not add it back.
- **`E1` already starts a refresh.** Do not send `E2` after `E1`. The firmware notifies `FF FF` on the data characteristic when a refresh finishes. `refresh()` registers its listener before it writes. Without notifications, it falls back to a 2.5 s delay.
- **Image buffer:** 2,756 bytes. It is **transposed**: 13 bytes per column, MSB-first (`buffer[x * 13 + floor(y / 8)]`), and 1 means white. `image.ts` encodes and decodes this layout, and `image.test.ts` pins it. Uploads use 16-byte chunks behind a 3-byte `03 offHi offLo` header to fit the default 20-byte ATT payload. They use acknowledged writes with 20 ms pacing, then `01` (display) and `04` (save to flash).

## Webtool structure

- `useBoard.ts` holds all Bluetooth state and commands as one composable. Every device action goes through `run()`, which is mutually exclusive. Only GATT `connect()` is retried. Application writes are never replayed, because they have side effects. A `connectionAttempt` counter cancels stale async work.
- `useBoard.test.ts` mocks `navigator.bluetooth` with fake characteristics and fake timers. Protocol changes should come with byte-level assertions there.
- `App.vue` is the single-page UI (connection, display, image, log). `DevicePreview.vue` shows the clock and calendar modes as static SVG sketches in `src/previews/`. Each sketch is based on its firmware renderer's coordinates and uses fixed sample data (Mon 5 Oct 2026, 10:10). They show the layout only, so update them when a firmware page layout changes. Only the Image preview shows real pixels.
- The UI is English only, with no `localStorage`. The theme follows the OS (`ink` / `ink-dark` in `src/style.css`).
- The app enters through `index.html` → `src/main.ts`. The old standalone tool (`2_13_eink_config.html`) was removed; see git history.

## Firmware notes

- `user_custs1_impl.c` holds the BLE handlers, the mode dispatch (`display()`), image load/save, and the timers. Each page has its own renderer: `time_display.c`, `calendar_display.c`, `analog_clock.c`, and `fabric_record_display.c` (unused by the webtool). These draw through `GUI_Paint.c` → `EPD_2in13_V2.c`.
- The lunar date is computed on the device from tables in `lunar/lunar.c`. The browser sends only a timezone-adjusted Unix timestamp (`DD` + 4 bytes, big-endian). Whether the tables follow Vietnam's UTC+7 calendar is unverified.
- `EPD_DrawUTF8()` and the `Fonts/*VI.c` files provide Vietnamese glyphs.
- `ImageData.c` is about 54k lines of bitmap data. Avoid reading it whole.
- Comments are often in Vietnamese.
- This repo's firmware may not match what is actually flashed on the board.
