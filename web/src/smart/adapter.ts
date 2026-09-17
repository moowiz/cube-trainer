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
  /** the MAC dialog, when the library could not read it: null cancels */
  askMac(deviceName: string): Promise<string | null>;
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

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!navigator.bluetooth;
}

/** Open the browser's device chooser and connect. Rejects when the user cancels or the cube is not supported. */
export async function connectCube(opts: ConnectOpts): Promise<CubeLink> {
  const now = opts.now ?? (() => performance.now());
  const conn = await connectSmartCube({
    onStatus: opts.onStatus,
    macAddressProvider: async (device, isFallback) => {
      const name = device.name ?? 'cube';
      const known = rememberedMac(name);
      if (known) return known;
      if (!isFallback) return null; // let the library read it from the advertisement first
      const mac = await opts.askMac(name);
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
