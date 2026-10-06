# Custom e-ink display — Codex handoff

Date: 2026-10-05
Owner: Tuan / Tony

## Purpose and scope

Continue exploring custom firmware for Tuan’s DA14585 e-ink board, with a Vietnamese lunar calendar and proper Vietnamese Unicode text. The discussion refers to a 212×104 display.

This file summarizes the accessible discussions, especially **Inspect Lunar Calendar Implementation** and **DA14585 Board Summary**. It records previous source-inspection findings; it is not a new hardware verification or source audit. No custom firmware, Mac utility, or font generator has been created in this local workspace.

## Reference repository

- Repository: https://github.com/T-Anh17/eink_da14585_104x212
- Previously inspected commit: `133bd03`.
- Firmware: `projects/target_apps/ble_examples/ble_app_ota/src/`.
- Browser configurator: `webtool/`.
- The project was described as a modified Dialog SDK 6.0.18 `ble_app_ota` example.
- Earlier web-fetch failures were tool `DisabledError` errors, not evidence that GitHub blocked downloads. A subsequent Git clone succeeded in the earlier cloud session.
- Earlier clones were in temporary cloud directories; do not assume those paths exist on this Mac.

Repository behavior must be distinguished from the firmware actually installed on Tuan’s board. That match has not been verified.

## Lunar-calendar findings

The inspected firmware calculates the lunar date on the DA14585. The browser sends the current time, not the lunar date.

1. The browser sends `0xDD` followed by a four-byte timestamp adjusted for the computer’s local timezone.
2. A firmware timer advances `current_unix_time` each minute and updates the display.
3. `LUNAR_SolarToLunar()` in `lunar/lunar.c` performs conversion using embedded tables:
   - `solar_1_1`: Gregorian date of lunar New Year for each year.
   - `lunar_month_days`: lunar month lengths and leap-month position.
4. The converter counts days since lunar New Year and walks the lunar months to return year, month, day, and leap-month flag.
5. `time_display.c` renders `Âm lịch: DD-MM-YYYY`, with `(N)` for a leap month. The calendar page also derives the lunar year’s Can–Chi name.

This table-based conversion needs no network connection or runtime astronomical calculations. The separate tiết khí feature uses a lookup table described as covering 2000–2050.

### Unresolved accuracy questions

- The conversion has no timezone argument. Vietnamese text does not prove that its tables follow the Vietnamese UTC+7 calendar.
- Validate the tables against a trusted Vietnamese calendar, including leap months and dates where Vietnam and China differ.
- Determine the lunar tables’ supported year range and behavior outside it.
- Check timekeeping drift, reboot persistence, day rollover, and the timezone-adjusted timestamp convention before changing clock handling.

## Vietnamese Unicode fonts

Proper Vietnamese text is feasible in custom firmware using embedded bitmap fonts.

Existing foundations reported in the inspected source:

- `EPD_DrawUTF8()` decodes UTF-8 and looks up character bitmaps.
- `Fonts/font16VI.c` provides 8×14 and 16×16 Vietnamese glyph sets, each with 134 non-ASCII characters.
- The clock’s current `Âm lịch` label nevertheless uses ASCII `Am lich:` with accents drawn manually.

Proposed approach, not yet implemented:

- Generate monochrome bitmap glyphs on the Mac from a font with Vietnamese coverage, then embed them in firmware.
- Start with a 14–16 pixel font and preview it at the display’s actual resolution.
- Use consistent baselines and enough space for accents above and below letters.
- Normalize incoming text to NFC before sending or generating it. The existing renderer does not compose separate combining marks.
- Use real UTF-8 labels such as `Âm lịch`, `Thứ Hai`, `Bính Ngọ`, and `Tháng nhuận`.
- Verify glyph coverage for punctuation and symbols as well as Vietnamese letters; Vietnamese coverage is not full Unicode coverage.

Estimated raw pixel storage: 134 monochrome 16×16 glyphs require 4,288 bytes, plus mappings and the ASCII set. Measure actual firmware size and available flash before committing to a font set.

## Bluetooth application protocol

Previously traced in `user_custs1_impl.c` at commit `133bd03`.

Service UUID: `00001f10-0000-1000-8000-00805f9b34fb`.

All payload bytes below are hexadecimal. Multi-byte numbers use big-endian order. The destination characteristic matters: `AA` and `AB` have different meanings on the two characteristics.

### Control characteristic

UUID: `00001f1f-0000-1000-8000-00805f9b34fb`

| Payload | Effect |
| --- | --- |
| `DD t0 t1 t2 t3` | Set time using a four-byte timestamp; the browser adds the local timezone offset. |
| `E2` | Force a full refresh of the current display mode. |
| `E3` | Select the digital clock page, including lunar date. |
| `E4` | Select monthly calendar with digital clock. |
| `E5` | Select monthly calendar with analog clock. |
| `E6` | Select fabric-record page. |
| `E1 mode` | Select a mode using the table below. |
| `F0 field text…` | Set a fabric-record field using UTF-8; does not immediately refresh the screen. |
| `AA` | Reboot the board. |
| `AB` | No effect; the image-save call is commented out. |

### Image/data characteristic

UUID: `00001f11-0000-1000-8000-00805f9b34fb`

| Payload | Effect |
| --- | --- |
| `02 offsetHi offsetLo` | Begin upload, switch to image mode, and record a starting position. Subsequent chunks supply their own offsets. |
| `03 offsetHi offsetLo data…` | Write bitmap bytes into the display buffer at the supplied offset. |
| `03 FF offsetHi offsetLo data…` | Alternate accepted chunk format. |
| `01` | Display the uploaded buffer with a full refresh and calculate its image header and CRC. |
| `04` | Attempt to save the image to flash. |
| `AA` | Same image-save operation as `04`. |
| `06 s0 s1 s2 s3` | Set image-size metadata; does not resize the display buffer. |
| `AB` | Reboot the board. |
| `E1 mode` | Select a display mode. |
| `E3`, `E4`, `E5`, `E6` | Same page selections as on the control characteristic. |
| `00 extraByte` | No effect; despite a clear-screen comment, the handler simply returns. |

The image handler rejects mode changes and reboot while the display pipeline is busy. Upload, display-trigger, and save commands bypass that guard. Recheck packet-length and buffer-bound handling before building an uploader.

### Mode values for `E1`

| Value | Mode |
| --- | --- |
| `00` | Digital clock |
| `01` | Calendar with digital clock |
| `02` | Calendar with analog clock |
| `03` | Image; loads the saved image from flash |
| `04` | Fabric record |

Example: send `E1 00` to select the clock, then `E2` on the control characteristic to refresh it.

### Field values for `F0`

| Value | Field | Value | Field |
| --- | --- | --- | --- |
| `00` | Width | `06` | Color |
| `01` | Staff | `07` | Lot |
| `02` | PO | `08` | Buy |
| `03` | Relax date | `09` | Roll |
| `04` | OK date | `0A` | Yards |
| `05` | Item | `0B` | Note |

There is no listed application command to set a lunar date separately, change fonts, or draw arbitrary text on the clock page. Those need firmware changes. Arbitrary visuals can instead be sent as bitmaps. Firmware updates use the separate Dialog SUOTA protocol.

## Mac-based board inspection and OTA

Tuan prefers checking GATT from the Mac and does not want to install a phone app just for this check.

A Python + Bleak utility was proposed to scan, let the user choose a device, connect, and print all GATT services and characteristic properties. It was shown in chat but has not been created or run here. macOS may require Bluetooth permission for the process hosting the utility.

Look for Dialog SUOTA service UUID `0000fef5-0000-1000-8000-00805f9b34fb` (`FEF5`). Its presence would support further investigation of wireless firmware updates, but does not alone establish image compatibility, flash layout, or a safe recovery path.

The hoped-for workflow is C firmware → build → DA14585 binary → SUOTA image generation → BLE update. Keep SUOTA in future custom firmware so later updates can remain wireless. This workflow has not been verified on Tuan’s board. The prior discussion explicitly deferred an OTA update until after GATT inspection.

## Suggested next work for Codex

These are proposed follow-ups, not completed work or a finalized implementation specification:

1. Obtain the reference source in a separate working directory and compare it with commit `133bd03`.
2. Create and run a Mac GATT inspection utility; record services and properties without issuing application writes or flashing firmware.
3. Audit build tooling, SUOTA packaging, flash layout, and recovery options for this exact board.
4. Inspect e-paper driver, partial refresh, timekeeping, temperature, battery, and BLE input validation.
5. Validate the lunar tables against Vietnamese UTC+7 dates and document supported ranges.
6. Build a font-generation and screen-preview workflow, then replace manually accented labels with UTF-8 rendering.
7. Establish a reproducible firmware build and review the hardware evidence before planning an OTA test.

No specific font family, final screen layout, build toolchain, or new application has been selected.

## Working preferences and workspace rules

- Keep communication short, direct, and simple.
- Treat everything under `sources/` as read-only synced reference material; do not modify, move, rename, or delete it.
- For TypeScript, avoid type casts and `any` where possible.
- Use globally installed `npm-check-updates` (`ncu`) when checking or updating packages.
- Merge PRs with a regular merge commit; never squash or rebase merge.
- For large code changes, delegate implementation to a lower-tier subagent and keep planning, review, and integration in the main session, as requested in the user’s AGENTS.md instructions.
