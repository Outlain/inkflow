import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installInkflowNativeBridge,
  NATIVE_PENCIL_SQUEEZE_EVENT,
  NATIVE_PENCIL_SWITCH_PREVIOUS_EVENT,
  type NativeBridgeWindow
} from './nativeBridge';

describe('installInkflowNativeBridge', () => {
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalWindow = globalThis.window;
    const mockWindow = new EventTarget() as NativeBridgeWindow;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: mockWindow
    });

    const nativeWindow = mockWindow;
    delete nativeWindow.__inkflowNativeBridgeInstalled;
    delete nativeWindow.__inkflowDispatchPencilSqueeze;
    delete nativeWindow.__inkflowDispatchSwitchPreviousTool;
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
      return;
    }

    Reflect.deleteProperty(globalThis, 'window');
  });

  it('dispatches a pencil squeeze event with detail', () => {
    const listener = vi.fn();
    window.addEventListener(NATIVE_PENCIL_SQUEEZE_EVENT, listener as EventListener);

    installInkflowNativeBridge();
    (window as NativeBridgeWindow).__inkflowDispatchPencilSqueeze?.({
      clientX: 144,
      clientY: 288,
      source: 'apple-pencil-pro'
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      clientX: 144,
      clientY: 288,
      source: 'apple-pencil-pro'
    });

    window.removeEventListener(NATIVE_PENCIL_SQUEEZE_EVENT, listener as EventListener);
  });

  it('dispatches the switch-previous-tool event', () => {
    const listener = vi.fn();
    window.addEventListener(NATIVE_PENCIL_SWITCH_PREVIOUS_EVENT, listener as EventListener);

    installInkflowNativeBridge();
    (window as NativeBridgeWindow).__inkflowDispatchSwitchPreviousTool?.();

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(NATIVE_PENCIL_SWITCH_PREVIOUS_EVENT, listener as EventListener);
  });
});
