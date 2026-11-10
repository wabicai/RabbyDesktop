import { IS_RUNTIME_PRODUCTION } from '@/isomorphic/constants';
import { isInternalProtocol, safeParseURL } from '@/isomorphic/url';
import { randString } from '@/isomorphic/string';
import { catchError, filter as filterOp, of, Subject, timeout } from 'rxjs';
import { arraify } from '@/isomorphic/array';
import { handleIpcMainInvoke, sendToWebContents } from '../utils/ipcMainEvents';
import {
  getSessionInsts,
  getAllMainUIViews,
  stopSelectDevices,
  startSelectDevices,
  getRabbyExtId,
} from '../utils/stream-helpers';
import { filterNodeHIDDevices } from '../utils/devices';

async function pushHidSelectDevices(deviceList: IHidDevice[]) {
  const { views } = await getAllMainUIViews();
  const targeWins = [views['select-devices']];

  targeWins.forEach((window) => {
    sendToWebContents(
      window.webContents,
      '__internal_push:webhid:select-list',
      {
        // deviceList: mergeNodeHIDInfo(deviceList),
        deviceList,
      }
    );
  });
}

const SelectSubject = new Subject<ISelectDeviceState>();
const selecteDevice$ = SelectSubject.asObservable();

handleIpcMainInvoke('confirm-selected-device', (_, payload) => {
  SelectSubject.next({
    selectId: payload.selectId,
    ...(!payload.device
      ? {
          status: 'rejected',
        }
      : {
          status: 'selected',
          deviceInfo: {
            productId: payload.device.productId,
            vendorId: payload.device.vendorId,
            deviceId: payload.device.deviceId,
          },
        }),
  });

  return {
    error: '',
  };
});

const SELECT_DEVICE_TIMEOUT = 180 * 1e3;

// OneKey WebUSB descriptors, mirrored from ONEKEY_WEBUSB_FILTER in
// @onekeyfe/hd-shared 1.2.7. Only these devices are granted to RabbyX.
const ONEKEY_USB_IDS: ReadonlyArray<{ vendorId: number; productId: number }> = [
  { vendorId: 0x1209, productId: 0x53c0 }, // Classic / Classic 1s / Mini bootloader
  { vendorId: 0x1209, productId: 0x53c1 }, // Classic / Classic 1s / Mini / Pro / Touch firmware
  { vendorId: 0x1209, productId: 0x4f4a }, // Pro / Touch bootloader, Pro 2
  { vendorId: 0x1209, productId: 0x4f4b }, // Pro / Touch firmware, Pro 2
  { vendorId: 0x1209, productId: 0x4f4c }, // Pro 2 current firmware (Protocol V2)
];

export function isOneKeyUsbDevice(device: unknown) {
  const { vendorId, productId } = (device || {}) as {
    vendorId?: unknown;
    productId?: unknown;
  };
  return ONEKEY_USB_IDS.some(
    (id) => id.vendorId === vendorId && id.productId === productId
  );
}

function originOfFrame(frame: { url?: string } | null | undefined) {
  const url = frame?.url ? safeParseURL(frame.url) : null;
  return url ? `${url.protocol}//${url.host}` : null;
}

const ONEKEY_IFRAME_ORIGIN = 'https://jssdk.onekey.so';

/**
 * Picks the device for `navigator.usb.requestDevice()`. Without a
 * `select-usb-device` handler Electron cancels every request. Only the RabbyX
 * background page, or the OneKey SDK iframe inside it, may pick, and only a
 * OneKey device. Returns undefined, which cancels the request, otherwise.
 */
export function pickOneKeyUsbDevice(
  details: {
    frame?: {
      url?: string;
      top?: { url?: string } | null;
    } | null;
    deviceList?: ReadonlyArray<{
      deviceId: string;
      vendorId?: number;
      productId?: number;
    }>;
  },
  rabbyOrigin: string | undefined
) {
  if (!rabbyOrigin) return undefined;
  const { frame } = details;
  const frameOrigin = originOfFrame(frame);
  const topUrl = frame?.top ? frame.top.url : frame?.url;
  if (
    topUrl !== `${rabbyOrigin}/background.html` ||
    (frameOrigin !== rabbyOrigin && frameOrigin !== ONEKEY_IFRAME_ORIGIN)
  ) {
    return undefined;
  }
  return (details.deviceList || []).find(isOneKeyUsbDevice)?.deviceId;
}

getSessionInsts().then((allSessions) => {
  const { mainSession } = allSessions;
  const grantedHidDevices = new Set<string>();
  let rabbyOrigin: string | undefined;

  // Register before the extension id is known so no USB/HID grant falls back
  // to Electron's default while getRabbyExtId() is pending.
  // A custom USB grant handler also owns HID grants in Electron.
  mainSession.setDevicePermissionHandler(({ deviceType, origin, device }) => {
    if (deviceType === 'usb') {
      return (
        !!rabbyOrigin && origin === rabbyOrigin && isOneKeyUsbDevice(device)
      );
    }
    return (
      deviceType === 'hid' &&
      'deviceId' in device &&
      grantedHidDevices.has(`${origin}:${device.deviceId}`)
    );
  });

  getRabbyExtId().then((id) => {
    rabbyOrigin = `chrome-extension://${id}`;
  });

  mainSession.on('hid-device-revoked', (_, { device, origin }) => {
    if (origin) {
      grantedHidDevices.delete(`${origin}:${device.deviceId}`);
    }
  });

  mainSession.on(
    'select-hid-device',
    (eventSelectHidDevice, details, callback) => {
      eventSelectHidDevice.preventDefault();
      // leave here for debug
      // console.debug('[debug] select-hid-device:: details', details);

      const frameOrigin = originOfFrame(details.frame);
      if (!frameOrigin) {
        // The requesting frame is gone (or has no parseable URL): nothing to grant.
        callback(null);
        return;
      }

      if (details.deviceList.length === 1) {
        grantedHidDevices.add(
          `${frameOrigin}:${details.deviceList[0].deviceId}`
        );
        callback(details.deviceList[0].deviceId);
        return;
      }

      const selectId = randString();
      SelectSubject.next({ selectId, status: 'pending' });

      pushHidSelectDevices(details.deviceList);
      const sub = selecteDevice$
        .pipe(
          filterOp(
            ({ selectId: sid, status }) =>
              sid === selectId && status !== 'pending'
          ),
          // TODO: should we support timeout mechanism here?
          timeout(SELECT_DEVICE_TIMEOUT),
          catchError(() => {
            return of({ selectId, status: 'rejected' as const });
          })
        )
        .subscribe((selectResult) => {
          // leave here for debug
          // console.debug('[debug] select-hid-device:: selectResult', selectResult);
          sub.unsubscribe();
          stopSelectDevices();

          switch (selectResult.status) {
            default:
              throw new Error(`unexpected status ${selectResult.status}`);
            case 'rejected':
              callback(null);
              break;
            case 'selected': {
              const selectedId = selectResult.deviceInfo.deviceId;

              if (!details.deviceList.find((d) => d.deviceId === selectedId)) {
                console.error(
                  `[error] select-hid-device:: device ${selectedId} not found`
                );
                callback(null);
              } else {
                grantedHidDevices.add(`${frameOrigin}:${selectedId}`);
                callback(selectResult.deviceInfo.deviceId);
              }

              break;
            }
          }
        });

      startSelectDevices(selectId);

      mainSession.on('hid-device-added', (_, eventDetails) => {
        console.debug('hid-device-added FIRED WITH', eventDetails.device);
        // Optionally update details.deviceList
        const eids = new Set(details.deviceList.map((d) => d.deviceId));
        let updated = false;
        const devices = arraify(eventDetails?.device).filter(Boolean);
        devices.forEach((d) => {
          if (!eids.has(d.deviceId)) {
            details.deviceList.push(d);
            updated = true;
          }
        });

        if (updated) {
          pushHidSelectDevices(details.deviceList);
        }
      });

      mainSession.on('hid-device-removed', (_, eventDetails) => {
        console.debug('hid-device-removed FIRED WITH', eventDetails.device);
        const devices = arraify(eventDetails?.device).filter(Boolean);
        const rids = new Set(devices.map((d) => d.deviceId));
        // Optionally update details.deviceList
        details.deviceList = details.deviceList.filter(
          (d) => !rids.has(d.deviceId)
        );

        pushHidSelectDevices(details.deviceList);
      });
    }
  );

  mainSession.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    let deviceId: string | undefined;
    try {
      deviceId = pickOneKeyUsbDevice(details, rabbyOrigin);
    } catch (err) {
      console.error('[error] select-usb-device::', err);
    }
    if (!IS_RUNTIME_PRODUCTION) {
      console.debug(
        `[debug] select-usb-device:: ${deviceId ? 'picked' : 'cancelled'}`,
        details.deviceList?.length
      );
    }
    // callback() with no id cancels requestDevice() with NotFoundError.
    if (deviceId) callback(deviceId);
    else callback();
  });

  Object.keys(allSessions).forEach((_sessName) => {
    const sessName = _sessName as keyof typeof allSessions;
    const inst = allSessions[sessName];

    inst.setPermissionCheckHandler(
      (requestingContents, permission, requestingOrigin, details) => {
        const isMainSession = sessName === 'mainSession';

        // leave here for debug
        // console.debug('[debug] setPermissionCheckHandler:: permission', permission);
        if (!IS_RUNTIME_PRODUCTION && sessName === 'checkingViewSession') {
          console.debug(
            `[session:${sessName}] Permission '${permission}' requested from ${requestingOrigin} with details:`,
            details
          );
        }

        switch (permission) {
          case 'usb': {
            const url = safeParseURL(requestingOrigin);
            const fromRabby =
              !!url && `${url.protocol}//${url.host}` === rabbyOrigin;
            const fromOneKeyIframe =
              url?.origin === 'https://jssdk.onekey.so' &&
              details.embeddingOrigin === rabbyOrigin &&
              details.isMainFrame === false;
            // Electron's USB delegate can check the top-level origin without WebContents.
            return (
              isMainSession &&
              (fromRabby || fromOneKeyIframe) &&
              (requestingContents
                ? requestingContents.getURL() ===
                  `${rabbyOrigin}/background.html`
                : fromRabby)
            );
          }
          case 'clipboard-sanitized-write':
          case 'accessibility-events':
          case 'background-sync':
            return isMainSession;
          case 'serial':
          case 'hid':
          case 'notifications': // restrain permissions of non-mainSession webContents, such as dapp's preview webview
          default: {
            if (isInternalProtocol(requestingOrigin)) {
              return isMainSession;
            }
            break;
          }
        }

        if (!IS_RUNTIME_PRODUCTION) {
          console.log(
            `[session:${sessName}] Permission Denied: called for ${permission} from ${requestingOrigin} with details:`,
            details
          );
        }

        return false;
      }
    );
  });
});

handleIpcMainInvoke('get-hid-devices', async (_, opts) => {
  return filterNodeHIDDevices(opts);
});
