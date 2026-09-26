// The only file that talks to the vendor library (smartcube-web-bluetooth,
// MIT): connect a smart cube over Web Bluetooth and turn what it says into
// capture events with the host clock on each. Everything after this is
// pure and replayable (source.ts, sync.ts).
//
// GAN cubes derive their key from the MAC address, which Web Bluetooth
// hides: the library tries to read it from the advertisement, then asks
// `askMac` (a one-time dialog; remembered per device name).
//
// Two ways in. `connectCube` opens the browser's chooser (a tap). `autoConnect`
// takes the cube the chooser last picked from Chrome's permitted-device list
// (`getDevices`, no tap needed), waits for its advertisement and connects the
// moment it is heard: the page reconnects on load and after a dropped link.
// The library's connect always calls the chooser, so the second path repeats
// its GATT-first driver pick (service UUIDs -> protocol) here.

import { connectSmartCube, getRegisteredProtocols, type SmartCubeConnection, type SmartCubeEvent, type SmartCubeProtocol } from 'smartcube-web-bluetooth';
import { asMove, type CaptureEvent } from './capture';

export interface CubeLink {
  name: string;
  mac: string;
  protocol: string;
  caps: SmartCubeConnection['capabilities'];
  requestFacelets(): Promise<void>;
  requestBattery(): Promise<void>;
  /** tell the cube its own state is solved (GAN keeps its facelets in firmware and drifts when it misses a turn) */
  reset(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ConnectOpts {
  /** every event, already stamped with host time; the connect event comes first, the disconnect last */
  onEvent(e: CaptureEvent): void;
  /** the MAC dialog, when the library could not read it: null cancels. `why` is the probe's verdict (probeAdvertisement) */
  askMac(deviceName: string, why: string): Promise<string | null>;
  onStatus?(msg: string): void;
  /** something the user should know once, on the connect that was fine otherwise (the auto-connect will not work, and why) */
  onWarning?(msg: string): void;
  now?(): number;
}

/** The Chrome flag that makes the chooser's picks persist (getDevices returns them); the API alone does not. */
export const PERMISSIONS_HINT = 'turn on chrome://flags/#enable-web-bluetooth-new-permissions-backend, relaunch Chrome, connect once with the button, then reload';

const MAC_KEY = 'cube.smart.mac.v1';
const DEVICE_KEY = 'cube.smart.device.v1';

/** The cube the chooser last picked: Chrome's per-origin device id and the name, for the chip. */
export interface RememberedDevice { id: string; name: string }

export function rememberedDevice(): RememberedDevice | null {
  try {
    const d = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null') as RememberedDevice | null;
    return d && typeof d.id === 'string' && typeof d.name === 'string' ? d : null;
  } catch { return null; }
}
function rememberDevice(d: RememberedDevice | null): void {
  try { if (d) localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); else localStorage.removeItem(DEVICE_KEY); } catch { /* no storage */ }
}

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
async function probeAdvertisement(device: BluetoothDevice, log: (msg: string) => void, timeoutMs = 5000): Promise<{ mac: string | null; verdict: string }> {
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

type Log = (msg: string) => void;

/** The MAC step the library asks for, shared by both ways in: remembered, else the advertisement, else the dialog. */
function macProvider(opts: ConnectOpts, log: Log, heard: BluetoothManufacturerData | null) {
  let verdict = 'the advertisement was not probed';
  return async (device: BluetoothDevice, isFallback?: boolean): Promise<string | null> => {
    const name = device.name ?? 'cube';
    const known = rememberedMac(name);
    if (known) { log(`MAC: remembered ${known} for ${name}`); return known; }
    if (!isFallback) {
      // an advertisement already in hand (the auto-connect heard one) is read first; else listen for one
      const fromHeard = heard ? macFromManufacturerData(heard) : null;
      if (fromHeard) { log(`MAC: read ${fromHeard} from the advertisement that woke the auto-connect`); rememberMac(name, fromHeard); return fromHeard; }
      // the library would try the advertisement next; do it ourselves first so the outcome is visible
      const r = await probeAdvertisement(device, log);
      verdict = r.verdict;
      if (r.mac) rememberMac(name, r.mac);
      return r.mac;
    }
    const mac = await opts.askMac(name, verdict);
    if (mac) rememberMac(name, mac);
    return mac;
  };
}

/** The GAN MAC out of a manufacturer-data map (the probe's convention: the last 6 of the first 9 bytes, reversed), or null. */
export function macFromManufacturerData(md: BluetoothManufacturerData): string | null {
  const ids = [...md.keys()];
  const gan = ids.find((id) => (id & 0xff) === 0x01);
  if (gan === undefined) return null;
  const dv = md.get(gan)!;
  const bytes = [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)];
  if (bytes.length < 6) return null;
  return bytes.slice(0, 9).slice(-6).reverse().map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

/** Open the browser's device chooser and connect. Rejects when the user cancels or the cube is not supported. */
export async function connectCube(opts: ConnectOpts): Promise<CubeLink> {
  const log: Log = (msg) => { console.info(`[smart] ${msg}`); opts.onStatus?.(msg); };
  const conn = await connectSmartCube({ onStatus: opts.onStatus, macAddressProvider: macProvider(opts, log, null) });
  // the chooser's pick is remembered for the auto-connect (its id is what getDevices hands back)
  const support = autoConnectSupport();
  if (support.ok) {
    const picked = await permittedDevices().then((ds) => ds.find((d) => d.name === conn.deviceName) ?? null).catch(() => null);
    if (picked) rememberDevice({ id: picked.id, name: conn.deviceName });
    else opts.onWarning?.(`Chrome did not keep the permission for ${conn.deviceName}, so it will not auto-connect: ${PERMISSIONS_HINT}`);
  } else opts.onWarning?.(`This browser cannot auto-connect (${support.why})`);
  return wrap(conn, opts);
}

/** The connection as our link: events stamped with the host clock, the first requests sent. */
async function wrap(conn: SmartCubeConnection, opts: ConnectOpts): Promise<CubeLink> {
  const now = opts.now ?? (() => performance.now());
  const link: CubeLink = {
    name: conn.deviceName,
    mac: conn.deviceMAC,
    protocol: conn.protocol.name,
    caps: conn.capabilities,
    requestFacelets: () => (conn.capabilities.facelets ? conn.sendCommand({ type: 'REQUEST_FACELETS' }) : Promise.resolve()),
    requestBattery: () => (conn.capabilities.battery ? conn.sendCommand({ type: 'REQUEST_BATTERY' }) : Promise.resolve()),
    reset: () => (conn.capabilities.reset ? conn.sendCommand({ type: 'REQUEST_RESET' }) : Promise.resolve()),
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

// ---- the auto-connect: a permitted device, heard, then connected without the chooser -----------------

type Watchable = BluetoothDevice & { watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void> };

/** Chrome's permitted-device list (the new permissions backend); [] where the API is missing. */
export async function permittedDevices(): Promise<BluetoothDevice[]> {
  const bt = bluetoothAvailable() ? (navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) : null;
  if (!bt || typeof bt.getDevices !== 'function') return [];
  try { return await bt.getDevices(); } catch { return []; }
}

/**
 * Whether this browser can reconnect without the chooser, and how: `getDevices` (the permitted-device list)
 * is the must; `watchAdvertisements` (experimental flag) lets the page wait for the cube instead of polling.
 */
export function autoConnectSupport(): { ok: true; watch: boolean } | { ok: false; why: string } {
  if (!bluetoothAvailable()) return { ok: false, why: 'this browser has no Web Bluetooth' };
  const bt = navigator.bluetooth as Bluetooth & { getDevices?: unknown };
  if (typeof bt.getDevices !== 'function') return { ok: false, why: `this Chrome has no getDevices API: ${PERMISSIONS_HINT}` };
  const watch = typeof (globalThis as { BluetoothDevice?: { prototype?: { watchAdvertisements?: unknown } } }).BluetoothDevice?.prototype?.watchAdvertisements === 'function';
  return { ok: true, watch };
}

/**
 * The remembered cube among the permitted devices: by id first; failing that (Chrome re-issues ids when
 * site data is cleared) the one permitted device a registered protocol recognises by name, if there is
 * exactly one. Pure over the lists, for the test.
 */
export function pickKnownDevice(devices: readonly BluetoothDevice[], remembered: RememberedDevice | null, protocols: readonly Pick<SmartCubeProtocol, 'matchesDevice'>[] = getRegisteredProtocols()): BluetoothDevice | null {
  if (remembered) {
    const byId = devices.find((d) => d.id === remembered.id);
    if (byId) return byId;
  }
  const cubes = devices.filter((d) => protocols.some((p) => p.matchesDevice(d)));
  return cubes.length === 1 ? cubes[0]! : null;
}

/** Resolve on the device's first advertisement (its manufacturer data), reject on abort or when the API refuses. */
export function hearAdvertisement(device: BluetoothDevice, signal: AbortSignal): Promise<BluetoothManufacturerData | null> {
  const d = device as Watchable;
  return new Promise((resolve, reject) => {
    if (typeof d.watchAdvertisements !== 'function') { reject(new Error('no watchAdvertisements API')); return; }
    const ctl = new AbortController();
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      device.removeEventListener('advertisementreceived', onAdv);
      signal.removeEventListener('abort', onAbort);
      ctl.abort();
      f();
    };
    const onAdv = (evt: Event) => finish(() => resolve((evt as BluetoothAdvertisingEvent).manufacturerData ?? null));
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    device.addEventListener('advertisementreceived', onAdv);
    d.watchAdvertisements({ signal: ctl.signal }).catch((err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
  });
}

/** The library's driver pick: the protocol with the highest GATT affinity, ties to the one that knows the name. */
export function resolveProtocol(protocols: readonly SmartCubeProtocol[], serviceUuids: ReadonlySet<string>, device: BluetoothDevice): SmartCubeProtocol | null {
  const ranked = protocols.map((p) => ({ p, score: p.gattAffinity(serviceUuids, device) }));
  const max = Math.max(-1, ...ranked.map((r) => r.score));
  if (max > 0) {
    const top = ranked.filter((r) => r.score === max);
    return (top.find((r) => r.p.matchesDevice(device)) ?? top[0]!).p;
  }
  return protocols.find((p) => p.matchesDevice(device)) ?? null;
}

/** 128-bit lowercase, the form the protocols compare against. */
export function normalizeUuid(uuid: string | number): string {
  if (typeof uuid === 'number') return `${uuid.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
  const u = uuid.trim().toLowerCase();
  return /^(0x)?[0-9a-f]{1,8}$/.test(u) ? normalizeUuid(parseInt(u, 16)) : u;
}

/** Connect an already-permitted device (no chooser): GATT, primary services, the protocol they name, its session. */
async function attachKnown(device: BluetoothDevice, opts: ConnectOpts, log: Log, heard: BluetoothManufacturerData | null): Promise<SmartCubeConnection> {
  const gatt = device.gatt;
  if (!gatt) throw new Error('GATT unavailable on this device');
  log(`Connecting to ${device.name ?? 'the cube'}…`);
  // DECISION: one connect with a 20 s timeout; the library retries twice more, but here the caller's
  // next attempt is the retry.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gatt.connect(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('GATT connection timeout')), 20_000); }),
    ]);
  } catch (err) {
    try { gatt.disconnect(); } catch { /* ignore */ }
    throw err;
  } finally { clearTimeout(timer); }
  const serviceUuids = new Set<string>();
  try { for (const s of await gatt.getPrimaryServices()) serviceUuids.add(normalizeUuid(s.uuid)); }
  catch (err) { try { gatt.disconnect(); } catch { /* ignore */ } throw err; }
  const protocol = resolveProtocol(getRegisteredProtocols(), serviceUuids, device);
  if (!protocol) {
    try { gatt.disconnect(); } catch { /* ignore */ }
    throw new Error(`${device.name ?? 'the device'} matches no smart cube protocol`);
  }
  log(`Driver: ${protocol.nameFilters.map((f) => ('namePrefix' in f ? f.namePrefix : f.name)).join('/')}`);
  try {
    return await protocol.connect(device, macProvider(opts, log, heard), { serviceUuids, advertisementManufacturerData: heard, onStatus: opts.onStatus });
  } catch (err) {
    try { gatt.disconnect(); } catch { /* ignore */ }
    throw err;
  }
}

export interface AutoConnectOpts extends ConnectOpts {
  /** the device to wait for (the caller picked it, `pickKnownDevice`) */
  device: BluetoothDevice;
  /** wait for the cube's advertisement before connecting (needs watchAdvertisements); false connects straight away */
  watch?: boolean;
  /** stop waiting (the user tapped Connect or Disconnect, or the page is going away) */
  signal: AbortSignal;
  /** the attach step, injectable for the test; defaults to the GATT path above */
  attach?(device: BluetoothDevice, heard: BluetoothManufacturerData | null): Promise<SmartCubeConnection>;
}

/**
 * Connect a permitted device without the chooser: wait for its advertisement when the browser can
 * (`watch`), else try the GATT connection straight away (Chrome scans for a permitted device itself;
 * it fails after its own timeout when the cube is not around, and the caller tries again). Rejects with
 * AbortError on the signal, or with the connect failure.
 */
export async function autoConnect(opts: AutoConnectOpts): Promise<CubeLink> {
  const log: Log = (msg) => { console.info(`[smart] ${msg}`); opts.onStatus?.(msg); };
  const name = opts.device.name ?? 'the cube';
  let heard: BluetoothManufacturerData | null = null;
  if (opts.watch ?? true) {
    log(`Listening for ${name}…`);
    heard = await hearAdvertisement(opts.device, opts.signal);
  } else {
    log(`Trying ${name}…`);
  }
  if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const conn = await (opts.attach ?? ((d, h) => attachKnown(d, opts, log, h)))(opts.device, heard);
  rememberDevice({ id: opts.device.id, name: conn.deviceName });
  return wrap(conn, opts);
}
