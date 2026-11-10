const mockMainSession = {
  on: jest.fn(),
  setDevicePermissionHandler: jest.fn(),
  setPermissionCheckHandler: jest.fn(),
};
const mockDappSession = { setPermissionCheckHandler: jest.fn() };

jest.mock('../utils/stream-helpers', () => ({
  getSessionInsts: async () => ({
    mainSession: mockMainSession,
    checkingViewSession: mockDappSession,
  }),
  getRabbyExtId: async () => 'rabby',
  getAllMainUIViews: jest.fn(),
  startSelectDevices: jest.fn(),
  stopSelectDevices: jest.fn(),
}));
jest.mock('../utils/ipcMainEvents', () => ({
  handleIpcMainInvoke: jest.fn(),
  sendToWebContents: jest.fn(),
}));
jest.mock('../utils/devices', () => ({ filterNodeHIDDevices: jest.fn() }));

describe('Rabby desktop native WebUSB permissions', () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.requireActual('./hid');
    await Promise.resolve();
    await Promise.resolve();
  });

  function devicePermission() {
    return mockMainSession.setDevicePermissionHandler.mock.calls[0][0];
  }

  const ONEKEY_PRO2 = { vendorId: 0x1209, productId: 0x4f4c };

  it.each([
    [0x1209, 0x53c0],
    [0x1209, 0x53c1],
    [0x1209, 0x4f4a],
    [0x1209, 0x4f4b],
    [0x1209, 0x4f4c],
  ])(
    'grants USB discovery of OneKey %i:%i to the loaded RabbyX origin',
    (vendorId, productId) => {
      expect(
        devicePermission()({
          deviceType: 'usb',
          origin: 'chrome-extension://rabby',
          device: { vendorId, productId },
        })
      ).toBe(true);
    }
  );

  it.each([
    ['no descriptor', {}],
    ['Ledger', { vendorId: 0x2c97, productId: 0x4011 }],
    ['other 0x1209 device', { vendorId: 0x1209, productId: 0x0001 }],
  ])('denies USB discovery of %s even to RabbyX', (_name, device) => {
    expect(
      devicePermission()({
        deviceType: 'usb',
        origin: 'chrome-extension://rabby',
        device,
      })
    ).toBe(false);
  });

  it.each([
    'https://dapp.example',
    'https://jssdk.onekey.so',
    'chrome-extension://other',
  ])('denies USB discovery to %s', (origin) => {
    expect(
      devicePermission()({ deviceType: 'usb', origin, device: ONEKEY_PRO2 })
    ).toBe(false);
  });

  it('requires the RabbyX background page and main session for USB requests', () => {
    const contents = {
      getURL: () => 'chrome-extension://rabby/background.html',
    };
    const checkMain =
      mockMainSession.setPermissionCheckHandler.mock.calls[0][0];
    const checkDapp =
      mockDappSession.setPermissionCheckHandler.mock.calls[0][0];
    expect(checkMain(contents, 'usb', 'chrome-extension://rabby', {})).toBe(
      true
    );
    expect(
      checkMain(
        { getURL: () => 'https://dapp.example' },
        'usb',
        'chrome-extension://rabby',
        {}
      )
    ).toBe(false);
    expect(checkMain(contents, 'usb', 'chrome-extension://other', {})).toBe(
      false
    );
    expect(checkDapp(contents, 'usb', 'chrome-extension://rabby', {})).toBe(
      false
    );
  });

  it('allows the OneKey iframe only inside the loaded RabbyX background page', () => {
    const check = mockMainSession.setPermissionCheckHandler.mock.calls[0][0];
    const contents = {
      getURL: () => 'chrome-extension://rabby/background.html',
    };
    const details = {
      embeddingOrigin: 'chrome-extension://rabby',
      isMainFrame: false,
    };
    expect(check(contents, 'usb', 'https://jssdk.onekey.so/', details)).toBe(
      true
    );
    expect(
      check(contents, 'usb', 'https://jssdk.onekey.so.evil.example', details)
    ).toBe(false);
    expect(
      check(contents, 'usb', 'https://jssdk.onekey.so', {
        ...details,
        embeddingOrigin: 'https://dapp.example',
      })
    ).toBe(false);
    expect(
      check(contents, 'usb', 'https://jssdk.onekey.so', {
        ...details,
        isMainFrame: true,
      })
    ).toBe(false);
    expect(
      check(
        { getURL: () => 'chrome-extension://other/background.html' },
        'usb',
        'https://jssdk.onekey.so',
        details
      )
    ).toBe(false);
  });

  it('allows Electron USB delegate checks only for the loaded RabbyX origin and session', () => {
    const check = mockMainSession.setPermissionCheckHandler.mock.calls[0][0];
    const checkDapp =
      mockDappSession.setPermissionCheckHandler.mock.calls[0][0];
    expect(check(null, 'usb', 'chrome-extension://rabby/', {})).toBe(true);
    expect(check(null, 'usb', 'chrome-extension://other/', {})).toBe(false);
    expect(check(null, 'usb', 'https://jssdk.onekey.so/', {})).toBe(false);
    expect(checkDapp(null, 'usb', 'chrome-extension://rabby/', {})).toBe(false);
  });

  it('preserves selected HID grants and revokes them when the device is forgotten', () => {
    const request = {
      deviceType: 'hid',
      origin: 'chrome-extension://rabby',
      device: { deviceId: 'ledger-id' },
    };
    expect(devicePermission()(request)).toBe(false);
    const select = mockMainSession.on.mock.calls.find(
      ([event]) => event === 'select-hid-device'
    )![1];
    const callback = jest.fn();
    select(
      { preventDefault: jest.fn() },
      {
        frame: { url: 'chrome-extension://rabby/background.html' },
        deviceList: [{ deviceId: 'ledger-id' }],
      },
      callback
    );
    expect(callback).toHaveBeenCalledWith('ledger-id');
    expect(devicePermission()(request)).toBe(true);
    expect(
      devicePermission()({ ...request, origin: 'chrome-extension://other' })
    ).toBe(false);
    const revoke = mockMainSession.on.mock.calls.find(
      ([event]) => event === 'hid-device-revoked'
    )![1];
    revoke({}, { origin: request.origin, device: request.device });
    expect(devicePermission()(request)).toBe(false);
  });

  it.each([
    ['null frame', null],
    ['frame without url', { url: '' }],
    ['unparseable frame url', { url: 'not a url' }],
  ])('rejects HID selection with a %s instead of throwing', (_name, frame) => {
    const select = mockMainSession.on.mock.calls.find(
      ([event]) => event === 'select-hid-device'
    )![1];
    const callback = jest.fn();
    expect(() =>
      select(
        { preventDefault: jest.fn() },
        { frame, deviceList: [{ deviceId: 'ledger-id' }] },
        callback
      )
    ).not.toThrow();
    expect(callback).toHaveBeenCalledWith(null);
    expect(
      devicePermission()({
        deviceType: 'hid',
        origin: 'chrome-extension://rabby',
        device: { deviceId: 'ledger-id' },
      })
    ).toBe(false);
  });
});
