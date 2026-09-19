// The only file that talks to the vendor library (smartcube-web-bluetooth,
// MIT): connect a smart cube over Web Bluetooth and turn what it says into
// capture events with the host clock on each. Everything after this is
// pure and replayable (source.ts, sync.ts).
//
// GAN cubes derive their key from the MAC address, which Web Bluetooth
// hides: the library tries to read it from the advertisement, then asks
// `askMac` (a one-time dialog; remembered per device name).

import { connectSmartCube, type SmartCubeConnection, type SmartCubeEvent } from 'smartcube-web-bluetooth';
import { asMove, type CaptureEvent } from './capture';

export interface CubeLink {
  name: string;
  mac: string;
  protocol: string;
  caps: SmartCubeConnection['capabilities'];
  requestFacelets(): Promise<void>;
  requestBattery(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ConnectOpts {
  /** every event, already stamped with host time; the connect event comes first, the disconnect last */
  onEvent(e: CaptureEvent): void;
  /** the MAC dialog, when the library could not read it: null cancels. `why` is the probe's verdict (probeAdvertisement) */
  askMac(deviceName: string, why: string): Promise<string | null>;
  onStatus?(msg: string): void;
  now?(): number;
}

const MAC_KEY = 'cube.smart.mac.v1';

function rememberedMac(name: string): string | null {
  try { return (JSON.parse(localStorage.getItem(MAC_KEY) || '{}') as Record<string, string>)[name] ?? null; } catch { return null; }
}
function rememberMac(name: string, mac: string): void {
  try {
    const m = JSON.parse(localStorage.getItem(MAC_KEY) || '{}') as Record<string, string>;
    m[name] = mac;
    localStorage.setItem(MAC_KEY, JSON.stringify(m));
  } catch { /* no storage */ }
}

/**
 * Why the browser could or could not read the MAC from the cube's advertisement: the same
 * watchAdvertisements path the library takes, but with every step reported (console + status).
 * Returns the MAC when the probe itself found it, else null and a one-line verdict.
 */
export async function probeAdvertisement(device: BluetoothDevice, log: (msg: string) => void, timeoutMs = 5000): Promise<{ mac: string | null; verdict: string }> {
  const d = device as BluetoothDevice & { watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void>; watchingAdvertisements?: boolean };
  if (typeof d.watchAdvertisements !== 'function') {
    const verdict = 'this Chrome has no watchAdvertisements API: the experimental-web-platform-features flag is off, or not applied (relaunch Chrome after enabling)';
    log(`MAC probe: ${verdict}`);
    return { mac: null, verdict };
  }
  log(`MAC probe: watchAdvertisements exists; listening ${timeoutMs} ms for ${device.name ?? '?'} (${device.id})`);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const ctl = new AbortController();
    let done = false;
    const finish = (r: { mac: string | null; verdict: string }) => {
      if (done) return;
      done = true;
      device.removeEventListener('advertisementreceived', onAdv);
      ctl.abort();
      log(`MAC probe: ${r.verdict}`);
      resolve(r);
    };
    const onAdv = (evt: Event) => {
      const e = evt as BluetoothAdvertisingEvent;
      const ms = Math.round(performance.now() - t0);
      const ids = [...e.manufacturerData.keys()];
      const gan = ids.find((id) => (id & 0xff) === 0x01);
      if (gan === undefined) {
        finish({ mac: null, verdict: `advertisement after ${ms} ms (rssi ${e.rssi ?? '?'}) but no GAN manufacturer data; company ids [${ids.map((i) => '0x' + i.toString(16)).join(', ')}]` });
        return;
      }
      const dv = e.manufacturerData.get(gan)!;
      const bytes = [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)];
      if (bytes.length < 6) {
        finish({ mac: null, verdict: `GAN advertisement after ${ms} ms but only ${bytes.length} bytes of manufacturer data` });
        return;
      }
      // the library's convention: the MAC is the last 6 bytes of the first 9, reversed
      const first9 = bytes.slice(0, 9);
      const mac = first9.slice(-6).reverse().map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
      finish({ mac, verdict: `read MAC ${mac} from the advertisement after ${ms} ms (company id 0x${gan.toString(16)}, ${bytes.length} bytes)` });
    };
    device.addEventListener('advertisementreceived', onAdv);
    d.watchAdvertisements!({ signal: ctl.signal }).then(
      () => log(`MAC probe: watchAdvertisements() resolved (watching=${d.watchingAdvertisements})`),
      (err: unknown) => finish({ mac: null, verdict: `watchAdvertisements() rejected: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}` }),
    );
    setTimeout(() => finish({ mac: null, verdict: `no advertisement in ${timeoutMs} ms (the API works but the cube was not heard: is it awake and not connected to the GAN app?)` }), timeoutMs);
  });
}

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!navigator.bluetooth;
}

/** Open the browser's device chooser and connect. Rejects when the user cancels or the cube is not supported. */
export async function connectCube(opts: ConnectOpts): Promise<CubeLink> {
  const now = opts.now ?? (() => performance.now());
  let verdict = 'the advertisement was not probed';
  const log = (msg: string) => { console.info(`[smart] ${msg}`); opts.onStatus?.(msg); };
  const conn = await connectSmartCube({
    onStatus: opts.onStatus,
    macAddressProvider: async (device, isFallback) => {
      const name = device.name ?? 'cube';
      const known = rememberedMac(name);
      if (known) { log(`MAC: remembered ${known} for ${name}`); return known; }
      if (!isFallback) {
        // the library would try the advertisement next; do it ourselves first so the outcome is visible
        const r = await probeAdvertisement(device, log);
        verdict = r.verdict;
        if (r.mac) rememberMac(name, r.mac);
        return r.mac;
      }
      const mac = await opts.askMac(name, verdict);
      if (mac) rememberMac(name, mac);
      return mac;
    },
  });
  const link: CubeLink = {
    name: conn.deviceName,
    mac: conn.deviceMAC,
    protocol: conn.protocol.name,
    caps: conn.capabilities,
    requestFacelets: () => (conn.capabilities.facelets ? conn.sendCommand({ type: 'REQUEST_FACELETS' }) : Promise.resolve()),
    requestBattery: () => (conn.capabilities.battery ? conn.sendCommand({ type: 'REQUEST_BATTERY' }) : Promise.resolve()),
    disconnect: () => conn.disconnect(),
  };
  opts.onEvent({ kind: 'connect', t: now(), name: link.name, mac: link.mac, protocol: link.protocol, caps: { ...conn.capabilities } });
  conn.events$.subscribe({
    next: (ev: SmartCubeEvent) => {
      const t = now();
      switch (ev.type) {
        case 'MOVE': {
          const move = asMove(ev.move);
          if (!move) { console.warn('smart cube: unknown move', ev.move); return; }
          opts.onEvent({ kind: 'move', t, move, tRaw: ev.cubeTimestamp, tLocal: ev.localTimestamp });
          return;
        }
        case 'FACELETS': opts.onEvent({ kind: 'facelets', t, facelets: ev.facelets }); return;
        case 'BATTERY': opts.onEvent({ kind: 'battery', t, level: ev.batteryLevel }); return;
        case 'HARDWARE': opts.onEvent({ kind: 'hardware', t, hardwareName: ev.hardwareName, softwareVersion: ev.softwareVersion, hardwareVersion: ev.hardwareVersion, gyroSupported: ev.gyroSupported }); return;
        case 'DISCONNECT': opts.onEvent({ kind: 'disconnect', t }); return;
        case 'GYRO': return; // this cube has none; a later one's orientation is a later feature
      }
    },
    error: (err: unknown) => { console.warn('smart cube: event stream error', err); opts.onEvent({ kind: 'disconnect', t: now() }); },
  });
  // the state to start from, and the battery, straight away (both no-ops on a cube that cannot report them)
  if (conn.capabilities.hardware) conn.sendCommand({ type: 'REQUEST_HARDWARE' }).catch(() => undefined);
  await link.requestFacelets().catch(() => undefined);
  link.requestBattery().catch(() => undefined);
  return link;
}
