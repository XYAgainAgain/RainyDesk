/**
 * Rainscaper - Entry point
 *
 * TypeScript rewrite of the Rainscaper control panel.
 * Exports the Rainscaper class and singleton instance.
 */

export { Rainscaper } from './Rainscaper';
export { state } from './RainscaperState';
export { sync } from './StateSync';

export type { RainscaperConfig } from './Rainscaper';
export type { RainscaperMode, RainscaperTab, RainscaperStateData } from './RainscaperState';

// Re-export component types for consumers
export type { SliderConfig, SliderVariant } from './components/controls';
export type { SelectConfig, SelectOption } from './components/controls';
export type { ToggleConfig } from './components/controls';
export type { ControlGroupConfig, ControlGroupVariant } from './components/controls';

// Create and export singleton instance for backwards compatibility
import { Rainscaper } from './Rainscaper';
export const rainscaper = new Rainscaper();
