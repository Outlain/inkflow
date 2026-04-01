export interface NativePencilSqueezeDetail {
  clientX?: number;
  clientY?: number;
  source?: string;
}

export interface NativeBridgeWindow extends Window {
  __inkflowNativeBridgeInstalled?: boolean;
  __inkflowDispatchPencilSqueeze?: (detail?: NativePencilSqueezeDetail) => void;
  __inkflowDispatchSwitchPreviousTool?: () => void;
}

export const NATIVE_PENCIL_SQUEEZE_EVENT = 'inkflow-native-pencil-squeeze';
export const NATIVE_PENCIL_SWITCH_PREVIOUS_EVENT = 'inkflow-native-pencil-switch-previous';

function dispatchWindowEvent<T>(name: string, detail?: T): void {
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

export function installInkflowNativeBridge(): void {
  const nativeWindow = window as NativeBridgeWindow;
  if (nativeWindow.__inkflowNativeBridgeInstalled) {
    return;
  }

  nativeWindow.__inkflowDispatchPencilSqueeze = (detail?: NativePencilSqueezeDetail) => {
    dispatchWindowEvent(NATIVE_PENCIL_SQUEEZE_EVENT, detail);
  };
  nativeWindow.__inkflowDispatchSwitchPreviousTool = () => {
    dispatchWindowEvent(NATIVE_PENCIL_SWITCH_PREVIOUS_EVENT);
  };
  nativeWindow.__inkflowNativeBridgeInstalled = true;
}
