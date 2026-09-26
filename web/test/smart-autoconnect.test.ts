// The smart cube's auto-connect (src/smart/adapter.ts): the remembered cube out of Chrome's
// permitted-device list, its advertisement heard, the driver picked from the GATT services, and
// the connection wrapped like the chooser's - with a fake BluetoothDevice, no Bluetooth.
import { Subject } from 'rxjs';
import { getRegisteredProtocols, type SmartCubeConnection, type SmartCubeEvent } from 'smartcube-web-bluetooth';
import { describe, expect, it, vi } from 'vitest';
import {
  autoConnect, hearAdvertisement, macFromManufacturerData, normalizeUuid, pickKnownDevice, resolveProtocol,
} from '../src/smart/adapter';
import type { CaptureEvent } from '../src/smart/capture';

/** A device as the permitted list hands it back: an EventTarget with a name, an id, and (optionally) watchAdvertisements. */
function fakeDevice(name: string, id = `id-${name}`, watch = true): BluetoothDevice & { advertise(md?: Map<number, DataView>): void } {
  const t = new EventTarget() as unknown as BluetoothDevice & { advertise(md?: Map<number, DataView>): void; watchAdvertisements?: unknown };
  Object.assign(t, { name, id });
  if (watch) t.watchAdvertisements = vi.fn(async () => undefined);
  t.advertise = (md = new Map()) => {
    const evt = new Event('advertisementreceived') as Event & { manufacturerData: Map<number, DataView> };
    evt.manufacturerData = md;
    t.dispatchEvent(evt);
  };
  return t;
}

/** GAN manufacturer data carrying the MAC AB:12:34:56:78:9A (last 6 of the first 9 bytes, reversed). */
function ganData(): Map<number, DataView> {
  const bytes = new Uint8Array([0, 0, 0, 0x9a, 0x78, 0x56, 0x34, 0x12, 0xab, 7, 7]);
  return new Map([[0x0001, new DataView(bytes.buffer)]]);
}

describe('pickKnownDevice', () => {
  const gan = fakeDevice('GAN12345', 'a');
  const moyu = fakeDevice('WCU_MY32_AB', 'b');
  const watch = fakeDevice('Pixel Watch', 'c');
  it('takes the remembered id when it is still permitted', () => {
    expect(pickKnownDevice([watch, moyu, gan], { id: 'a', name: 'GAN12345' })).toBe(gan);
  });
  it('falls back to the one permitted cube when the id is gone (site data cleared), never to a non-cube', () => {
    expect(pickKnownDevice([watch, gan], { id: 'stale', name: 'GAN12345' })).toBe(gan);
    expect(pickKnownDevice([watch, gan], null)).toBe(gan);
    expect(pickKnownDevice([watch], null)).toBeNull();
  });
  it('refuses to guess between two cubes', () => {
    expect(pickKnownDevice([gan, moyu], null)).toBeNull();
  });
});

describe('hearAdvertisement', () => {
  it('resolves with the first advertisement\'s manufacturer data and stops watching', async () => {
    const d = fakeDevice('GAN12345');
    const ctl = new AbortController();
    const p = hearAdvertisement(d, ctl.signal);
    expect(d.watchAdvertisements).toHaveBeenCalledTimes(1);
    d.advertise(ganData());
    const md = await p;
    expect(md && macFromManufacturerData(md)).toBe('AB:12:34:56:78:9A');
    // a second advertisement after the first is not heard (the listener is gone)
    const signal = (d.watchAdvertisements as ReturnType<typeof vi.fn>).mock.calls[0]![0].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
  it('rejects with AbortError when the caller stops waiting', async () => {
    const d = fakeDevice('GAN12345');
    const ctl = new AbortController();
    const p = hearAdvertisement(d, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects where Chrome has no watchAdvertisements', async () => {
    await expect(hearAdvertisement(fakeDevice('GAN12345', 'x', false), new AbortController().signal)).rejects.toThrow(/watchAdvertisements/);
  });
});

describe('resolveProtocol', () => {
  it('names the GAN driver from the gen2 service, and by name alone when the services say nothing', () => {
    const protocols = getRegisteredProtocols();
    const gan = fakeDevice('GAN12345');
    const byGatt = resolveProtocol(protocols, new Set([normalizeUuid('6e400001-b5a3-f393-e0a9-e50e24dc4179')]), gan);
    expect(byGatt?.matchesDevice(gan)).toBe(true);
    const byName = resolveProtocol(protocols, new Set(), gan);
    expect(byName?.matchesDevice(gan)).toBe(true);
    expect(resolveProtocol(protocols, new Set(), fakeDevice('Pixel Watch'))).toBeNull();
  });
  it('normalises short UUIDs the way the protocols compare them', () => {
    expect(normalizeUuid(0x180a)).toBe('0000180a-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('FFF0')).toBe('0000fff0-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('6E400001-B5A3-F393-E0A9-E50E24DC4179')).toBe('6e400001-b5a3-f393-e0a9-e50e24dc4179');
  });
});

describe('autoConnect', () => {
  function fakeConn(name: string): SmartCubeConnection & { events: Subject<SmartCubeEvent>; sent: string[] } {
    const events = new Subject<SmartCubeEvent>();
    const sent: string[] = [];
    return {
      deviceName: name, deviceMAC: 'AB:12:34:56:78:9A', protocol: { name: 'GAN Gen2' } as SmartCubeConnection['protocol'],
      capabilities: { facelets: true, battery: true, hardware: false, reset: true, gyro: false, moves: true } as unknown as SmartCubeConnection['capabilities'],
      events$: events, events, sent,
      sendCommand: async (c) => { sent.push(c.type); },
      disconnect: async () => { events.next({ type: 'DISCONNECT', timestamp: 0 } as unknown as SmartCubeEvent); },
    };
  }

  it('waits for the advertisement, attaches with it in hand, and streams the cube\'s events with the host clock', async () => {
    const d = fakeDevice('GAN12345');
    const conn = fakeConn('GAN12345');
    const attach = vi.fn(async () => conn);
    const got: CaptureEvent[] = [];
    let t = 1000;
    const p = autoConnect({ device: d, signal: new AbortController().signal, attach, onEvent: (e) => got.push(e), askMac: async () => null, now: () => (t += 10) });
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled(); // nothing until the cube is heard
    d.advertise(ganData());
    const link = await p;
    expect(attach).toHaveBeenCalledTimes(1);
    const heard = (attach.mock.calls as unknown as [BluetoothDevice, Map<number, DataView>][])[0]![1];
    expect(macFromManufacturerData(heard)).toBe('AB:12:34:56:78:9A');
    expect(link.name).toBe('GAN12345');
    expect(conn.sent).toEqual(['REQUEST_FACELETS', 'REQUEST_BATTERY']);
    conn.events.next({ type: 'MOVE', move: "R'", cubeTimestamp: 5, localTimestamp: 6 } as unknown as SmartCubeEvent);
    expect(got.map((e) => e.kind)).toEqual(['connect', 'move']);
    expect(got[1]).toMatchObject({ kind: 'move', move: "R'", t: 1020 });
  });

  it('without watchAdvertisements (watch: false) it attaches straight away, with no advertisement in hand', async () => {
    const d = fakeDevice('GAN12345', 'x', false);
    const conn = fakeConn('GAN12345');
    const attach = vi.fn(async () => conn);
    const link = await autoConnect({ device: d, watch: false, signal: new AbortController().signal, attach, onEvent: () => undefined, askMac: async () => null });
    expect(attach).toHaveBeenCalledTimes(1);
    expect((attach.mock.calls as unknown as [BluetoothDevice, unknown][])[0]![1]).toBeNull();
    expect(link.name).toBe('GAN12345');
  });

  it('gives up cleanly when aborted while listening: no attach, an AbortError', async () => {
    const d = fakeDevice('GAN12345');
    const ctl = new AbortController();
    const attach = vi.fn();
    const p = autoConnect({ device: d, signal: ctl.signal, attach, onEvent: () => undefined, askMac: async () => null });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(attach).not.toHaveBeenCalled();
  });
});
