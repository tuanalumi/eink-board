# E-ink board

Vue 3 + TypeScript, Vite, Tailwind CSS 4, and daisyUI 5 configurator for the DA14585 2.13″ e-paper board (212 × 104 pixels).

```sh
npm ci
npm start
```

Open the localhost URL printed by Vite in desktop Chrome or Edge. Port 3000 is the default; Vite uses the next available port if occupied. Use Node 22.12+ or a supported newer release.

```sh
npm test        # Bitmap and mocked Bluetooth/protocol regression tests
npm run build  # Vue/TypeScript checks and production output in dist/
npm run preview
```

Deploy the contents of `dist/` to a static HTTPS host. Assets use relative paths so deployment under a subdirectory works. No backend is required. The only network call is the Random photo button, which fetches from picsum.photos.

## The page

One English-only page. It follows the OS light/dark theme. Nothing is stored locally.

- **Connection:** Connect (filtered chooser), Scan all BLE devices (only while disconnected), Cancel (while connecting), Disconnect, and a status line.
- **Display:** pick one of four firmware modes, preview it, then Apply mode, Sync time (sends the computer's local time), or Full refresh. Previews are illustrative sketches, not device readback. Applying Image recalls the image already saved on the board.
- **Image:** choose or drop an image, or load a random Unsplash photo via Picsum, adjust brightness, contrast, threshold and dithering (None, Ordered, Floyd–Steinberg, Atkinson), preview the exact monochrome buffer, then Upload & save (display plus flash save). Portrait images rotate; square images fit; other images crop to fill.
- **Activity log:** newest first, with Copy and Clear.

Images are processed in the browser and are not uploaded to a server.

## Bluetooth reliability

The normal connection uses the original device-name filters and service/characteristic UUIDs. **Scan all BLE devices** opens an unfiltered chooser for troubleshooting missing or different advertised names. Select only your board: the tool still checks its required GATT service and characteristics before enabling commands. Connecting discovers channels and subscribes to data-channel notifications; it does not send display commands.

- Failed setup closes any partially established GATT connection and removes listeners.
- After device selection, the entire GATT setup has a 20-second deadline. The status line and log show transport, service discovery, each characteristic, and notification setup separately. **Cancel** stops setup immediately; old results cannot update a new attempt. Use the browser chooser's own Cancel button while selecting a device.
- Only GATT connection attempts are retried (up to three); application writes and flash-save commands are never automatically replayed.
- Device operations are mutually exclusive. Image chunks use acknowledged writes and 16-byte payloads with 20 ms pacing.
- This repository's `E1` handler already starts a refresh, so mode selection does not send the old redundant `E2` refresh.
- Where supported, the tool waits for the firmware's `FF FF` refresh-complete notification. A 12-second timeout closes the connection. If notifications are unavailable, it logs that limitation and uses a 2.5-second fallback delay; that delay is not confirmation that the screen finished.
- The activity log records setup stages, failures, and disconnects, and can be copied for troubleshooting.

Use stable board power, keep the board nearby, grant OS/browser Bluetooth permission, and disconnect other apps using the board. A log and mocked tests cannot establish radio/firmware stability. Verify the actual board firmware and test real hardware before attributing dropouts to either side.

### Empty device chooser

1. Cancel the chooser, then try **Scan all BLE devices**. If the board appears there but not in the normal chooser, its advertised name does not match the filters or is unavailable to the browser.
2. On macOS, check **System Settings → Privacy & Security → Bluetooth** and allow the browser. Compare with desktop Chrome if Brave's chooser remains empty; Brave has a **Web Bluetooth API** flag in `brave://flags`.
3. Disconnect other Bluetooth apps/tabs, then power-cycle the board. This repository's firmware advertises as `IOT-EINK-` plus six hex digits, every 687.5 ms while disconnected, with no configured advertising timeout. The flashed firmware may differ. E-paper can retain an image when the board has no power.
4. If it is still absent, scan with a phone BLE scanner such as nRF Connect without connecting. Visible on the phone but not the computer points toward browser/OS discovery; absent on both points toward board power, firmware, or advertising rather than these name filters. This is diagnostic evidence, not proof of a hardware fault.

Different firmware can change both the advertised name and the GATT protocol. Scanning all devices only bypasses the name filter. This tool requires service `00001f10-0000-1000-8000-00805f9b34fb`, control characteristic `00001f1f-0000-1000-8000-00805f9b34fb`, and data characteristic `00001f11-0000-1000-8000-00805f9b34fb`. A failure at service/characteristic discovery can indicate firmware incompatibility; a transport timeout alone cannot identify the cause.

The Vue application enters through `index.html`.
