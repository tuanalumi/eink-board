import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, type EffectScope } from "vue";
import {
  CONTROL_UUID,
  DATA_UUID,
  SERVICE_UUID,
  timestampPacket,
  useBoard,
} from "./useBoard";

class Characteristic
  extends EventTarget
  implements BluetoothRemoteGATTCharacteristic
{
  properties = { notify: true };
  value = new DataView(new ArrayBuffer(2));
  packets: number[][] = [];
  writeValue = vi.fn(async (_value: BufferSource) => {});
  writeValueWithResponse = vi.fn(async (value: BufferSource) => {
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    this.packets.push(Array.from(bytes));
  });
  startNotifications = vi.fn(async () => this);
  notify(value = 0xffff) {
    this.value.setUint16(0, value);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

const scopes: EffectScope[] = [];
function fixture() {
  const control = new Characteristic();
  const data = new Characteristic();
  const getCharacteristic = vi.fn(async (uuid: string) =>
    uuid === CONTROL_UUID ? control : data,
  );
  const gatt: BluetoothRemoteGATTServer = {
    connected: false,
    connect: vi.fn(async () => {
      gatt.connected = true;
      return gatt;
    }),
    disconnect: vi.fn(() => {
      gatt.connected = false;
    }),
    getPrimaryService: vi.fn(async () => ({ getCharacteristic })),
  };
  const device = Object.assign(new EventTarget(), {
    id: "eink-test",
    name: "EINK-test",
    gatt,
  });
  const requestDevice = vi.fn(async () => device);
  vi.stubGlobal("navigator", { bluetooth: { requestDevice } });
  vi.stubGlobal("window", { isSecureContext: true });
  const scope = effectScope();
  scopes.push(scope);
  const board = scope.run(() => useBoard());
  if (!board) throw new Error("No effect scope.");
  return {
    board,
    control,
    data,
    device,
    gatt,
    requestDevice,
    getCharacteristic,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  scopes.splice(0).forEach((scope) => scope.stop());
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("board connection and command ordering", () => {
  it("connects and discovers both channels without sending display commands", async () => {
    const { board, control, data, gatt, requestDevice, getCharacteristic } =
      fixture();
    await board.connect();
    expect(board.connected.value).toBe(true);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [
        { namePrefix: "IOT-EINK" },
        { namePrefix: "DLG" },
        { namePrefix: "EINK" },
      ],
      optionalServices: [SERVICE_UUID],
    });
    expect(gatt.getPrimaryService).toHaveBeenCalledWith(SERVICE_UUID);
    expect(getCharacteristic.mock.calls.map((call) => call[0])).toEqual([
      CONTROL_UUID,
      DATA_UUID,
    ]);
    expect(control.packets).toEqual([]);
    expect(data.packets).toEqual([]);
    expect(board.lastMode.value).toBeNull();
  });

  it("scans without name filters only on explicit request and still validates the board service", async () => {
    const { board, requestDevice, gatt, control, data } = fixture();
    vi.mocked(gatt.getPrimaryService).mockRejectedValueOnce(
      new DOMException("Not an e-paper board", "NotFoundError"),
    );
    await board.connect(true);
    expect(requestDevice).toHaveBeenCalledWith({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    expect(gatt.getPrimaryService).toHaveBeenCalledWith(SERVICE_UUID);
    expect(board.connected.value).toBe(false);
    expect(board.error.value).toContain("Not an e-paper board");
    expect(gatt.disconnect).toHaveBeenCalledOnce();
    expect(control.packets).toEqual([]);
    expect(data.packets).toEqual([]);
  });

  it("disconnects an established transport when discovery fails, then allows a fresh connection", async () => {
    const { board, gatt, getCharacteristic } = fixture();
    getCharacteristic.mockRejectedValueOnce(
      new Error("Missing control characteristic"),
    );
    await board.connect();
    expect(gatt.disconnect).toHaveBeenCalledOnce();
    expect(board.connected.value).toBe(false);
    expect(board.connecting.value).toBe(false);
    expect(board.error.value).toContain("Missing control characteristic");
    await board.connect();
    expect(board.connected.value).toBe(true);
    expect(board.error.value).toBe("");
  });

  it("reports a missing GATT service as a setup error, not chooser cancellation", async () => {
    const { board, gatt } = fixture();
    vi.mocked(gatt.getPrimaryService).mockRejectedValueOnce(
      new DOMException("Service not found", "NotFoundError"),
    );
    await board.connect();
    expect(board.error.value).toContain("Service not found");
    expect(
      board.logs.value.some(
        (line) => line.message === "Device selection cancelled.",
      ),
    ).toBe(false);
    expect(gatt.disconnect).toHaveBeenCalledOnce();
  });

  it("retries only transport connection, with no application writes", async () => {
    const { board, gatt, control } = fixture();
    vi.mocked(gatt.connect)
      .mockRejectedValueOnce(new Error("Radio busy"))
      .mockRejectedValueOnce(new Error("Radio busy"));
    const pending = board.connect();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(gatt.connect).toHaveBeenCalledTimes(3);
    expect(board.connected.value).toBe(true);
    expect(control.packets).toEqual([]);
  });

  it.each([
    ["connect", "GATT · connecting"],
    ["service", "Finding e-paper service"],
    ["control", "Finding control characteristic"],
    ["data", "Finding data characteristic"],
    ["notifications", "Enabling display notifications"],
  ])(
    "bounds a stalled %s stage to 20 seconds and releases the UI",
    async (where, label) => {
      const { board, gatt, getCharacteristic, data, control } = fixture();
      const never = () => new Promise<never>(() => {});
      if (where === "connect")
        vi.mocked(gatt.connect).mockImplementationOnce(never);
      if (where === "service")
        vi.mocked(gatt.getPrimaryService).mockImplementationOnce(never);
      if (where === "control") getCharacteristic.mockImplementationOnce(never);
      if (where === "data")
        getCharacteristic.mockImplementation(async (uuid) =>
          uuid === DATA_UUID ? never() : control,
        );
      if (where === "notifications")
        data.startNotifications.mockImplementationOnce(never);
      const pending = board.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(board.connectionStage.value).toContain(label);
      await vi.advanceTimersByTimeAsync(19999);
      expect(board.connecting.value).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(board.connecting.value).toBe(false);
      await pending;
      expect(board.connected.value).toBe(false);
      expect(board.connectionStage.value).toBe("");
      expect(board.error.value).toContain("timed out (20 seconds)");
      expect(board.error.value).toContain(label);
      expect(gatt.disconnect).toHaveBeenCalledOnce();
      expect(control.packets).toEqual([]);
      expect(data.packets).toEqual([]);
    },
  );

  it("shares one deadline across transport and discovery instead of restarting it at each stage", async () => {
    const { board, gatt } = fixture();
    vi.mocked(gatt.connect).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 19000));
      gatt.connected = true;
      return gatt;
    });
    vi.mocked(gatt.getPrimaryService).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const pending = board.connect();
    await vi.advanceTimersByTimeAsync(19999);
    expect(board.connectionStage.value).toContain("Finding e-paper service");
    expect(board.connecting.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(board.connecting.value).toBe(false);
    await pending;
    expect(board.error.value).toContain("timed out");
    expect(gatt.connected).toBe(false);
  });

  it("ignores late notification failure from a cancelled session after reconnect", async () => {
    const { board, data } = fixture();
    let failOld = () => {};
    data.startNotifications.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failOld = () => reject(new Error("Old notification setup failed"));
        }),
    );
    const oldSetup = board.connect();
    await vi.advanceTimersByTimeAsync(0);
    board.cancelConnection();
    await board.connect();
    await oldSetup;
    const logs = [...board.logs.value];
    failOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(board.logs.value).toEqual(logs);
    expect(board.connected.value).toBe(true);
    const refresh = board.applyMode("calendar");
    data.notify();
    await refresh;
    expect(board.lastMode.value).toBe("calendar");
  });

  it.each(["resolve", "reject"] as const)(
    "cancels pending GATT even when disconnected and isolates its late %s from reconnect setup",
    async (outcome) => {
      const { board, gatt, data } = fixture();
      let settleOld = () => {};
      vi.mocked(gatt.connect).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settleOld = () =>
              outcome === "resolve"
                ? resolve(gatt)
                : reject(new Error("Old transport failed"));
          }),
      );
      const oldSetup = board.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(gatt.connected).toBe(false);
      board.cancelConnection();
      expect(gatt.disconnect).toHaveBeenCalledOnce();
      expect(board.connecting.value).toBe(false);
      let finishNotifications = () => {};
      data.startNotifications.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNotifications = () => resolve(data);
          }),
      );
      const newSetup = board.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(board.connectionStage.value).toContain(
        "Enabling display notifications",
      );
      settleOld();
      await vi.advanceTimersByTimeAsync(0);
      await oldSetup;
      expect(board.connecting.value).toBe(true);
      expect(board.connectionStage.value).toContain(
        "Enabling display notifications",
      );
      expect(board.error.value).toBe("");
      expect(gatt.disconnect).toHaveBeenCalledOnce();
      finishNotifications();
      await newSetup;
      expect(board.connected.value).toBe(true);
      expect(board.connecting.value).toBe(false);
    },
  );

  it("closes a late connection to an abandoned board without disconnecting the replacement board", async () => {
    const first = fixture();
    let finishOld = () => {};
    vi.mocked(first.gatt.connect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = () => {
            first.gatt.connected = true;
            resolve(first.gatt);
          };
        }),
    );
    const oldSetup = first.board.connect();
    await vi.advanceTimersByTimeAsync(20000);
    await oldSetup;
    const replacement = fixture();
    await first.board.connect();
    const logs = [...first.board.logs.value];
    finishOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.gatt.connected).toBe(false);
    expect(replacement.gatt.connected).toBe(true);
    expect(first.board.connected.value).toBe(true);
    expect(first.board.logs.value).toEqual(logs);
    expect(first.board.error.value).toBe("");
  });

  it("cancels retry backoff without an old retry interfering with the new connection", async () => {
    const { board, gatt } = fixture();
    vi.mocked(gatt.connect).mockRejectedValueOnce(new Error("Radio busy"));
    const oldSetup = board.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(board.connectionStage.value).toContain("Retrying GATT");
    board.cancelConnection();
    await board.connect();
    await oldSetup;
    await vi.advanceTimersByTimeAsync(1000);
    expect(gatt.connect).toHaveBeenCalledTimes(2);
    expect(board.connected.value).toBe(true);
    expect(board.error.value).toBe("");
  });

  it("releases a stalled discovery immediately on unexpected disconnect", async () => {
    const { board, gatt, device } = fixture();
    vi.mocked(gatt.getPrimaryService).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const pending = board.connect();
    await vi.advanceTimersByTimeAsync(0);
    gatt.connected = false;
    device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(board.connecting.value).toBe(false);
    await pending;
    expect(board.error.value).toContain("Device disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the setup deadline only after the user has selected a device", async () => {
    const { board, device, requestDevice, gatt } = fixture();
    let choose = () => {};
    requestDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          choose = () => resolve(device);
        }),
    );
    const pending = board.connect();
    await vi.advanceTimersByTimeAsync(30000);
    expect(board.connecting.value).toBe(true);
    expect(board.connectionStage.value).toContain("Bluetooth dialog");
    expect(gatt.connect).not.toHaveBeenCalled();
    choose();
    await pending;
    expect(board.connected.value).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a chooser result after the Vue scope is disposed", async () => {
    const { board, device, requestDevice, gatt } = fixture();
    let choose = () => {};
    requestDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          choose = () => resolve(device);
        }),
    );
    const pending = board.connect();
    scopes.at(-1)?.stop();
    choose();
    await pending;
    expect(board.connected.value).toBe(false);
    expect(board.connecting.value).toBe(false);
    expect(gatt.connect).not.toHaveBeenCalled();
  });

  it("does not turn chooser cancellation into a transport retry or a visible error", async () => {
    const { board, requestDevice, gatt } = fixture();
    requestDevice.mockRejectedValueOnce(
      new DOMException("Cancelled", "NotFoundError"),
    );
    await board.connect();
    expect(gatt.connect).not.toHaveBeenCalled();
    expect(board.error.value).toBe("");
    expect(board.connecting.value).toBe(false);
    expect(board.logs.value.at(-1)?.message).toBe(
      "Device selection cancelled.",
    );
  });

  it("reports Brave's globally-disabled API error instead of treating it as cancellation", async () => {
    const { board, requestDevice, gatt } = fixture();
    requestDevice.mockRejectedValueOnce(
      new DOMException("Web Bluetooth API globally disabled.", "NotFoundError"),
    );
    await board.connect();
    expect(gatt.connect).not.toHaveBeenCalled();
    expect(board.error.value).toContain("globally disabled");
    expect(board.connecting.value).toBe(false);
  });

  it("holds the operation lock until BOTH the response and notification arrive", async () => {
    const { board, control, data } = fixture();
    await board.connect();
    let release = () => {};
    control.writeValueWithResponse.mockImplementationOnce(async (value) => {
      control.packets.push(
        Array.from(
          new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer),
        ),
      );
      data.notify();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = board.applyMode("calendarAnalog");
    await Promise.resolve();
    expect(board.busy.value).not.toBe("");
    await board.syncTime();
    expect(control.packets).toEqual([[0xe1, 2]]);
    release();
    await pending;
    expect(board.lastMode.value).toBe("calendarAnalog");
    expect(board.busy.value).toBe("");
    expect(control.packets).toEqual([[0xe1, 2]]); // No redundant E2 refresh.
  });

  it("ignores chunk acknowledgements and waits for the actual refresh-complete event", async () => {
    const { board, data } = fixture();
    await board.connect();
    const pending = board.applyMode("calendar");
    data.notify(19);
    await Promise.resolve();
    expect(board.busy.value).not.toBe("");
    data.notify();
    await pending;
    expect(board.lastMode.value).toBe("calendar");
  });

  it("does not publish a mode if the board disconnects after completion but before the task resumes", async () => {
    const { board, data, device, gatt } = fixture();
    await board.connect();
    const pending = board.applyMode("image");
    await vi.advanceTimersByTimeAsync(0);
    data.notify();
    gatt.connected = false;
    device.dispatchEvent(new Event("gattserverdisconnected"));
    await pending;
    expect(board.lastMode.value).toBeNull();
    expect(board.connected.value).toBe(false);
    expect(board.busy.value).toBe("");
  });

  it("cleans up on disconnect without duplicating reconnect listeners", async () => {
    const { board, device, gatt, data } = fixture();
    await board.connect();
    gatt.connected = false;
    device.dispatchEvent(new Event("gattserverdisconnected"));
    await vi.advanceTimersByTimeAsync(0);
    expect(board.connected.value).toBe(false);
    expect(board.busy.value).toBe("");
    expect(board.lastMode.value).toBeNull();
    await board.connect();
    const pending = board.applyMode("clock");
    data.notify();
    await pending;
    const oldCount = board.logs.value.filter((line) =>
      line.message.startsWith("Device disconnected."),
    ).length;
    gatt.connected = false;
    device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(
      board.logs.value.filter((line) =>
        line.message.startsWith("Device disconnected."),
      ),
    ).toHaveLength(oldCount + 1);
  });

  it("times out a stalled refresh and disconnects instead of replaying a write", async () => {
    const { board, control, gatt } = fixture();
    await board.connect();
    const pending = board.applyMode("image");
    await vi.advanceTimersByTimeAsync(12000);
    await pending;
    expect(board.error.value).toContain("timed out");
    expect(gatt.disconnect).toHaveBeenCalledOnce();
    expect(board.connected.value).toBe(false);
    expect(board.busy.value).toBe("");
    expect(control.packets).toEqual([[0xe1, 3]]);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps reconnect completion listeners when a timed-out write later %ss",
    async (outcome) => {
      const { board, control, data } = fixture();
      await board.connect();
      let settle = () => {};
      control.writeValueWithResponse.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = () =>
              outcome === "resolve"
                ? resolve()
                : reject(new Error("Old write failed"));
          }),
      );
      const oldRefresh = board.applyMode("clock");
      data.notify();
      await vi.advanceTimersByTimeAsync(12000);
      await oldRefresh;
      expect(board.connected.value).toBe(false);

      await board.connect();
      const newRefresh = board.applyMode("calendar");
      await vi.advanceTimersByTimeAsync(0);
      settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(board.busy.value).not.toBe("");
      data.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(board.lastMode.value).toBe("calendar");
      expect(board.busy.value).toBe("");
      await newRefresh;
    },
  );

  it("uploads bounded, ordered chunks with a short final chunk before display and save", async () => {
    const { board, control, data } = fixture();
    await board.connect();
    const buffer = Uint8Array.from({ length: 2756 }, (_, i) => i % 251);
    const pending = board.uploadImage(buffer);
    await vi.advanceTimersByTimeAsync(3460);
    expect(data.packets[0]).toEqual([0x06, 0, 0, 0x0a, 0xc4]);
    expect(data.packets[1]).toEqual([0x02, 0, 0]);
    const chunks = data.packets.filter((packet) => packet[0] === 0x03);
    expect(chunks).toHaveLength(173);
    expect(chunks.every((packet) => packet.length <= 19)).toBe(true);
    expect(chunks[16].slice(0, 3)).toEqual([0x03, 1, 0]);
    expect(chunks.at(-1)).toEqual([0x03, 0x0a, 0xc0, 242, 243, 244, 245]);
    expect(chunks.flatMap((packet) => packet.slice(3))).toEqual(
      Array.from(buffer),
    );
    expect(data.packets.at(-1)).toEqual([0x01]);
    expect(data.packets.some((packet) => packet[0] === 0x04)).toBe(false);
    data.notify();
    await pending;
    expect(data.packets.at(-1)).toEqual([0x04]);
    expect(control.packets).toEqual([]);
    expect(board.progress.value).toBe(100);
    expect(board.lastMode.value).toBe("image");
  });

  it("stops an upload at the failed write and never displays or saves a partial image", async () => {
    const { board, data } = fixture();
    await board.connect();
    data.writeValueWithResponse
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("GATT write failed"));
    await board.uploadImage(new Uint8Array(2756));
    expect(data.writeValueWithResponse).toHaveBeenCalledTimes(3);
    expect(board.error.value).toContain("GATT write failed");
    expect(board.lastMode.value).toBeNull();
    expect(board.busy.value).toBe("");
    expect(board.progress.value).toBe(0);
  });

  it("falls back to a paced refresh when notifications cannot be enabled", async () => {
    const { board, data, control } = fixture();
    data.startNotifications.mockRejectedValueOnce(new Error("Not supported"));
    await board.connect();
    const pending = board.applyMode("image");
    await vi.advanceTimersByTimeAsync(2499);
    expect(board.busy.value).not.toBe("");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(control.packets).toEqual([[0xe1, 3]]);
    expect(board.lastMode.value).toBe("image");
  });
});

describe("firmware clock packet", () => {
  it("keeps big-endian clock bytes and the local-wall-clock timestamp convention", () => {
    const date = new Date("2026-10-05T03:04:05Z");
    vi.spyOn(date, "getTimezoneOffset").mockReturnValue(-420);
    // Independently checked with Python calendar.timegm: 1791194645 = 0x6ac37615.
    expect(Array.from(timestampPacket(date))).toEqual([
      0xdd, 0x6a, 0xc3, 0x76, 0x15,
    ]);
  });
});
