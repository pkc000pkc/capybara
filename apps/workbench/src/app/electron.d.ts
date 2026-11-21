import type { WorkbenchNativeBridge } from "./workbench-bridge";

declare global {
  interface Window {
    capybaraDesktop?: WorkbenchNativeBridge;
  }
}
