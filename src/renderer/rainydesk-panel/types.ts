/**
 * Type declarations for window.rainydesk Tauri API bridge
 */

declare global {
  interface Window {
    rainydesk: {
      log: (msg: string) => void;
      setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void;
      updateRainscapeParam: (path: string, value: unknown) => void;
      onUpdateRainscapeParam: (callback: (path: string, value: unknown) => void) => void;
      onLoadRainscape: (callback: (filename: string) => void) => void;
      resizeRainscaper: (width: number, height: number) => Promise<void>;
      saveRainscape: (name: string, data: unknown) => Promise<void>;
      readRainscape: (name: string) => Promise<Record<string, unknown>>;
      loadRainscapes: () => Promise<{ root: string[]; custom: string[] }>;
      getConfig: () => Promise<{ rainEnabled: boolean; intensity: number; volume: number; wind: number }>;
      getStartupRainscape: () => Promise<{ filename: string; data: Record<string, unknown> }>;
      hideRainscaper: () => Promise<void>;
      showRainscaper: (trayX: number, trayY: number) => Promise<void>;
      toggleRainscaper: (trayX: number, trayY: number) => Promise<void>;
      getWindowsAccentColor: () => Promise<string>;
      getDisplayInfo: () => Promise<{
        monitors: Array<{
          width: number;
          height: number;
          rel_x: number;
          rel_y: number;
          is_primary: boolean;
        }>;
        virtual_desktop: {
          width: number;
          height: number;
          x: number;
          y: number;
        };
      }>;
      // Stats bridge (overlay -> panel)
      emitStats: (stats: { fps: number; waterCount: number; activeDrops: number; puddleCells: number }) => void;
      onStats: (callback: (stats: { fps: number; waterCount: number; activeDrops: number; puddleCells: number }) => void) => void;
      // Reinitialization status events
      emitReinitStatus: (status: 'stopped' | 'initializing' | 'raining') => void;
      onReinitStatus: (callback: (status: 'stopped' | 'initializing' | 'raining') => void) => void;
      // Virtual desktop info (all monitors + bounding box)
      getVirtualDesktop: () => Promise<{
        width: number;
        height: number;
        originX: number;
        originY: number;
        primaryIndex: number;
        monitors: Array<{
          index: number;
          x: number;
          y: number;
          width: number;
          height: number;
          workX: number;
          workY: number;
          workWidth: number;
          workHeight: number;
          scaleFactor: number;
        }>;
      }>;
    };
  }
}

export {};
