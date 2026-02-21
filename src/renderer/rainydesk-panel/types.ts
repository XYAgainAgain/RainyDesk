/**
 * Type declarations for window.rainydesk Tauri API bridge
 */

// Custom theme data structures (persisted in UserThemes.json)
export interface CustomThemeColors {
  accent: string;
  background: string;
  text: string;
  autoColors: boolean;
  accentHover: string | null;
  accentActive: string | null;
  borderColor: string | null;
  shadowColor: string | null;
  closeHover: string | null;
  sliderTrack: string | null;
  toggleBg: string | null;
  textSecondary: string | null;
}

export interface CustomThemeFonts {
  body: string;
  headers: string;
  applyToMatrix: boolean;
}

export interface CustomTheme {
  id: string;
  name: string;
  colors: CustomThemeColors;
  fonts: CustomThemeFonts;
}

export interface UserThemesFile {
  version: number;
  themes: CustomTheme[];
}

// Named interfaces for IPC return types (reused across bridge + consumers)

export interface MonitorInfo {
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
  refreshRate: number;
}

export interface VirtualDesktop {
  width: number;
  height: number;
  originX: number;
  originY: number;
  primaryIndex: number;
  monitors: MonitorInfo[];
}

export interface DisplayInfo {
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
}

export interface PhantomDPIResult {
  factor: number;
  correctionZoom: number;
  corrected: boolean;
  virtualDesktop: VirtualDesktop | null;
}

export interface RendererStats {
  fps: number;
  waterCount: number;
  activeDrops: number;
  puddleCells: number;
}

// Debug log types

export interface DebugLogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DebugStats {
  fps: number;
  waterCount: number;
  activeDrops: number;
  puddleCells: number;
  frameTime: number;
  memoryMB: number;
  lastUpdate: number;
}

declare global {
  interface Window {
    rainydesk: {
      log: (msg: string) => void;
      setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void;
      updateRainscapeParam: (path: string, value: unknown) => void;
      onUpdateRainscapeParam: (callback: (path: string, value: unknown) => void) => void;
      onSetVolume: (callback: (value: number) => void) => void;
      onLoadRainscape: (callback: (filename: string) => void) => void;
      getPanelDetached: () => Promise<boolean>;
      setPanelDetached: (detached: boolean) => Promise<void>;
      snapPanelToTray: () => Promise<void>;
      resizeRainscaper: (width: number, height: number) => Promise<void>;
      saveRainscape: (name: string, data: unknown) => Promise<void>;
      readRainscape: (name: string) => Promise<Record<string, unknown>>;
      loadRainscapes: () => Promise<{ root: string[]; custom: string[] }>;
      getConfig: () => Promise<{ rainEnabled: boolean; intensity: number; volume: number; wind: number }>;
      getStartupRainscape: () => Promise<{ filename: string; data: Record<string, unknown> }>;
      hideRainscaper: () => Promise<void>;
      showRainscaper: (trayX: number, trayY: number) => Promise<void>;
      toggleRainscaper: (trayX: number, trayY: number) => Promise<void>;
      getVersion: () => Promise<string>;
      getWindowsAccentColor: () => Promise<string>;
      showHelpWindow: () => Promise<void>;
      hideHelpWindow: () => Promise<void>;
      resizeHelpWindow: (width: number, height: number) => Promise<void>;
      centerHelpWindow: () => Promise<void>;
      toggleMaximizeHelpWindow: () => Promise<boolean>;
      openUrl: (url: string) => Promise<void>;
      openRainscapesFolder: () => Promise<void>;
      openLogsFolder: () => Promise<void>;
      getDisplayInfo: () => Promise<DisplayInfo>;
      getVirtualDesktop: () => Promise<VirtualDesktop>;
      getSystemSpecs: () => Promise<{
        cpuModel: string;
        gpuModel: string;
        gpuVramGb: number | null;
        totalRamGb: number;
      }>;
      getAllDisplays: () => Promise<DisplayInfo>;
      // Event listeners (from Rust backend or cross-window IPC)
      onDisplayInfo: (callback: (info: DisplayInfo) => void) => void;
      onVirtualDesktop: (callback: (info: VirtualDesktop) => void) => void;
      onToggleRain: (callback: (enabled: boolean) => void) => void;
      onToggleAudio: (callback: (enabled: boolean) => void) => void;
      onWindowData: (callback: (data: unknown) => void) => Promise<() => void>;
      onToggleRainscaper: (callback: () => void) => void;
      // Rainscape management
      setRainscape: (name: string) => Promise<void>;
      autosaveRainscape: (data: unknown) => Promise<void>;
      // Audio start synchronization
      triggerAudioStart: () => Promise<void>;
      onStartAudio: (callback: () => void) => void;
      // WebView health heartbeat
      heartbeat: () => Promise<void>;
      // Stats bridge (overlay → panel) — emit() returns a promise
      emitStats: (stats: RendererStats) => Promise<void>;
      onStats: (callback: (stats: RendererStats) => void) => void;
      // Reinitialization status events — emit() returns a promise
      emitReinitStatus: (status: 'stopped' | 'initializing' | 'raining') => Promise<void>;
      onReinitStatus: (callback: (status: 'stopped' | 'initializing' | 'raining') => void) => void;
      // Per-monitor fullscreen state (overlay → background)
      emitFullscreenMonitors: (indices: number[]) => Promise<void>;
      onFullscreenMonitors: (callback: (indices: number[]) => void) => void;
      // Help window hidden event
      onHelpWindowHidden: (callback: () => void) => void;
      // Monitor hot-swap detection
      onMonitorConfigChanged: (callback: () => void) => void;
      // Phantom DPI scaling detection
      detectPhantomDPI: () => Promise<PhantomDPIResult>;
      // Custom themes I/O
      loadUserThemes: () => Promise<UserThemesFile>;
      saveUserThemes: (data: UserThemesFile) => Promise<void>;
    };

    // Debug log storage (initialized by tauri-api, consumed by panel)
    _debugLog: DebugLogEntry[];
    _debugLogMaxEntries: number;
    _debugStats: DebugStats;
    _addDebugLog: (level: 'info' | 'warn' | 'error', message: string) => void;
    _updateDebugStats: (stats: Partial<DebugStats>) => void;
  }
}

export {};
