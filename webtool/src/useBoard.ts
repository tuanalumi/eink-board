import { onScopeDispose, ref, shallowRef } from "vue";
import { BUFFER_SIZE } from "./image";

export type Mode = "clock" | "calendar" | "calendarAnalog" | "image";
// Array index is the firmware E1 mode value.
export const modes: Mode[] = ["clock", "calendar", "calendarAnalog", "image"];
export const SERVICE_UUID = "00001f10-0000-1000-8000-00805f9b34fb";
export const CONTROL_UUID = "00001f1f-0000-1000-8000-00805f9b34fb";
export const DATA_UUID = "00001f11-0000-1000-8000-00805f9b34fb";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function timestampPacket(date: Date): Uint8Array {
  const packet = new Uint8Array(5);
  packet[0] = 0xdd;
  new DataView(packet.buffer).setUint32(
    1,
    Math.floor(date.getTime() / 1000) - date.getTimezoneOffset() * 60,
  );
  return packet;
}

export function useBoard() {
  const connected = ref(false);
  const connecting = ref(false);
  const connectionStage = ref("");
  const deviceName = ref("");
  const busy = ref("");
  const lastMode = ref<Mode | null>(null);
  const progress = ref(0);
  const logs = shallowRef<
    Array<{ time: string; message: string; level: "info" | "error" }>
  >([]);
  const error = ref("");
  const bluetoothAvailable =
    typeof navigator !== "undefined" &&
    !!navigator.bluetooth &&
    window.isSecureContext;
  let device: BluetoothDevice | null = null;
  let control: BluetoothRemoteGATTCharacteristic | null = null;
  let data: BluetoothRemoteGATTCharacteristic | null = null;
  let notifications = false;
  let displayDone: (() => void) | null = null;
  let displayFailed: ((error: Error) => void) | null = null;
  let connectionAttempt = 0;
  let cancelSetup: ((cause: Error) => void) | null = null;

  function log(message: string, level: "info" | "error" = "info") {
    logs.value = [
      ...logs.value.slice(-199),
      { time: new Date().toLocaleTimeString("en-GB"), message, level },
    ];
    if (level === "error") error.value = message;
  }

  function onNotification(event: Event) {
    const target = event.target;
    if (target && "value" in target && target.value instanceof DataView) {
      const value = target.value;
      if (value.byteLength === 2 && value.getUint16(0) === 0xffff)
        displayDone?.();
    }
  }

  function resetConnection() {
    connectionAttempt++;
    const interrupt = cancelSetup;
    cancelSetup = null;
    interrupt?.(new Error("Connection attempt interrupted."));
    connecting.value = false;
    connectionStage.value = "";
    displayFailed?.(new Error("Disconnected during display refresh."));
    device?.removeEventListener("gattserverdisconnected", onDisconnected);
    data?.removeEventListener("characteristicvaluechanged", onNotification);
    const oldDevice = device;
    device = null;
    control = data = null;
    notifications = false;
    connected.value = false;
    lastMode.value = null;
    deviceName.value = "";
    // disconnect() also aborts pending connect() calls when connected is false.
    oldDevice?.gatt?.disconnect();
  }

  function onDisconnected() {
    log("Device disconnected. Check board power and reconnect.", "error");
    resetConnection();
  }

  async function connect(allDevices = false) {
    if (connecting.value || connected.value || busy.value) return;
    if (!bluetoothAvailable) {
      log("Use Chrome or Edge on HTTPS or localhost.", "error");
      return;
    }
    const attempt = ++connectionAttempt;
    connecting.value = true;
    error.value = "";
    let choosing = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function checkAttempt() {
      if (attempt !== connectionAttempt)
        throw new Error("Connection attempt interrupted.");
    }
    function stage(message: string) {
      checkAttempt();
      connectionStage.value = message;
      log(message);
    }
    try {
      stage(
        allDevices
          ? "Choose your board in the Bluetooth dialog (all BLE devices)."
          : "Choose your board in the Bluetooth dialog.",
      );
      const selected = await navigator.bluetooth.requestDevice({
        ...(allDevices
          ? { acceptAllDevices: true }
          : {
              filters: [
                { namePrefix: "IOT-EINK" },
                { namePrefix: "DLG" },
                { namePrefix: "EINK" },
              ],
            }),
        optionalServices: [SERVICE_UUID],
      });
      checkAttempt();
      choosing = false;
      device = selected;
      device.addEventListener("gattserverdisconnected", onDisconnected);
      deviceName.value = device.name || "E-Ink device";
      log(`Selected device: ${deviceName.value}`);
      if (!selected.gatt) throw new Error("Device has no GATT server.");
      const gatt = selected.gatt;
      const interrupted = new Promise<never>((_resolve, reject) => {
        cancelSetup = reject;
        // Bound all setup stages together; the user-controlled chooser has no deadline.
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Connection timed out (20 seconds): ${connectionStage.value}`,
            ),
          );
        }, 20000);
      });
      async function setup() {
        // Retry transport setup only, never replay an application write.
        for (let retry = 1; ; retry++) {
          stage(`GATT · connecting (${retry}/3)`);
          try {
            await gatt.connect();
            if (attempt !== connectionAttempt && device !== selected)
              gatt.disconnect();
            checkAttempt();
            break;
          } catch (cause) {
            checkAttempt();
            if (retry === 3) throw cause;
            stage(`Retrying GATT in 1 second: ${messageOf(cause)}`);
            await delay(1000);
          }
        }
        stage("Finding e-paper service…");
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        stage("Finding control characteristic…");
        const foundControl = await service.getCharacteristic(CONTROL_UUID);
        stage("Finding data characteristic…");
        const foundData = await service.getCharacteristic(DATA_UUID);
        checkAttempt();
        if (!gatt.connected)
          throw new Error("Disconnected during service discovery.");
        control = foundControl;
        data = foundData;
        if (foundData.properties?.notify && foundData.startNotifications) {
          stage("Enabling display notifications…");
          foundData.addEventListener(
            "characteristicvaluechanged",
            onNotification,
          );
          try {
            await foundData.startNotifications();
            checkAttempt();
            notifications = true;
          } catch (cause) {
            checkAttempt();
            log(`Display notifications unavailable: ${messageOf(cause)}`);
          }
        }
        checkAttempt();
        if (!gatt.connected)
          throw new Error("Disconnected during notification setup.");
      }
      await Promise.race([setup(), interrupted]);
      checkAttempt();
      connected.value = true;
      log("Connected. No commands have been sent to the board.");
      if (!notifications)
        log("No refresh-complete notifications; using a fallback delay.");
    } catch (cause) {
      if (attempt !== connectionAttempt) return;
      if (
        choosing &&
        cause instanceof Error &&
        cause.name === "NotFoundError" &&
        !cause.message.toLowerCase().includes("globally disabled")
      ) {
        log("Device selection cancelled.");
      } else {
        log(
          `Connection failed · ${connectionStage.value}: ${messageOf(cause)}`,
          "error",
        );
      }
      resetConnection();
    } finally {
      clearTimeout(timeout);
      if (attempt === connectionAttempt) {
        cancelSetup = null;
        connecting.value = false;
        connectionStage.value = "";
      }
    }
  }

  function cancelConnection() {
    if (!connecting.value || !device) return;
    resetConnection();
    log("Connection cancelled.");
  }

  function disconnect() {
    resetConnection();
    log("Disconnected.");
  }

  function messageOf(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
  }

  async function write(
    characteristic: BluetoothRemoteGATTCharacteristic | null,
    packet: Uint8Array,
  ) {
    if (!connected.value || !device?.gatt?.connected || !characteristic)
      throw new Error("Device is not connected.");
    // Acknowledged writes keep uploads ordered; do not retry side effects.
    if (characteristic.writeValueWithResponse)
      await characteristic.writeValueWithResponse(new Uint8Array(packet));
    else await characteristic.writeValue(new Uint8Array(packet));
    if (!connected.value) throw new Error("Device disconnected.");
  }

  async function refresh(
    packet: Uint8Array,
    channel: "control" | "data" = "control",
  ) {
    if (!notifications) {
      await write(channel === "control" ? control : data, packet);
      await delay(2500);
      if (!connected.value) throw new Error("Device disconnected.");
      return;
    }
    // Register before writing: a completion notification can arrive before write resolves.
    await new Promise<void>((resolve, reject) => {
      let notified = false;
      let written = false;
      let finished = false;
      const timeout = setTimeout(() => {
        finish(new Error("Display refresh timed out (12 seconds)."));
        resetConnection();
      }, 12000);
      function finish(cause?: Error) {
        // A late write response from an old session must not clear new listeners.
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        displayDone = displayFailed = null;
        if (cause) reject(cause);
        else resolve();
      }
      displayDone = () => {
        notified = true;
        if (written) finish();
      };
      displayFailed = finish;
      void write(channel === "control" ? control : data, packet)
        .then(() => {
          written = true;
          if (notified) finish();
        })
        .catch((cause) => finish(new Error(messageOf(cause))));
    });
    if (!connected.value) throw new Error("Device disconnected.");
  }

  async function run(title: string, task: () => Promise<void>) {
    if (busy.value || !connected.value) return;
    busy.value = title;
    error.value = "";
    log(title);
    try {
      await task();
    } catch (cause) {
      log(`${title}: ${messageOf(cause)}`, "error");
    } finally {
      busy.value = "";
    }
  }

  async function setMode(mode: Mode) {
    // E1 already starts a refresh in this firmware; E2 would restart it.
    await refresh(new Uint8Array([0xe1, modes.indexOf(mode)]));
    lastMode.value = mode;
    log(`Mode sent: ${mode}`);
  }

  const applyMode = (mode: Mode) =>
    run("Changing display mode", () => setMode(mode));
  const syncTime = () =>
    run("Syncing time", async () => {
      await write(control, timestampPacket(new Date()));
      await refresh(new Uint8Array([0xe2]));
      log("Computer time sent to the board.");
    });
  const refreshDisplay = () =>
    run("Refreshing display", () => refresh(new Uint8Array([0xe2])));

  const uploadImage = (buffer: Uint8Array) =>
    run("Uploading and saving image", async () => {
      if (buffer.length !== BUFFER_SIZE)
        throw new Error("Invalid display buffer size.");
      progress.value = 0;
      await write(
        data,
        new Uint8Array([0x06, 0, 0, buffer.length >> 8, buffer.length & 0xff]),
      );
      await write(data, new Uint8Array([0x02, 0, 0]));
      // 16-byte data + 3-byte header fits the default ATT payload (20 bytes).
      for (let offset = 0; offset < buffer.length; offset += 16) {
        await write(
          data,
          new Uint8Array([
            0x03,
            offset >> 8,
            offset & 0xff,
            ...buffer.slice(offset, offset + 16),
          ]),
        );
        progress.value = Math.round(
          (Math.min(offset + 16, buffer.length) / buffer.length) * 100,
        );
        await delay(20);
      }
      await refresh(new Uint8Array([0x01]), "data");
      await write(data, new Uint8Array([0x04]));
      lastMode.value = "image";
      log("Image displayed; flash-save command sent.");
    });

  log("Ready. Connect a device to begin.");
  onScopeDispose(resetConnection);
  return {
    connected,
    connecting,
    connectionStage,
    bluetoothAvailable,
    deviceName,
    busy,
    lastMode,
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
  };
}
