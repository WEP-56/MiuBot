/**
 * Terminal/theme compatibility layer.
 *
 * Pi's extension API surfaces terminal-UI concepts (TUI components, themes,
 * keybindings). Miubot runs headless, so those concepts are declared here as
 * inert types instead of being imported from a terminal renderer. Anything that
 * actually renders a component must go through the web UI instead.
 */

export type KeyId = string;

export type TerminalColorMode = "truecolor" | "256" | "ansi" | "none";

export interface TerminalCapabilities {
	images: "iterm2" | "kitty" | null;
	trueColor: boolean;
	hyperlinks: boolean;
	colorMode: TerminalColorMode;
}

export interface TUI {
	width: number;
	height: number;
}

export interface Component {
	render(width: number): string[];
	dispose?(): void;
}

export interface EditorComponent extends Component {
	getText(): string;
	setText(text: string): void;
}

export type AutocompleteItem = { value: string; label: string; description?: string };

export interface AutocompleteProvider {
	getSuggestions(input: string): AutocompleteItem[];
}

export interface OverlayOptions {
	anchor?: "top" | "bottom" | string;
	width?: number | string;
	maxHeight?: number | string;
}

export interface OverlayHandle {
	close(): void;
}

export interface EditorTheme {
	border: (text: string) => string;
	placeholder: (text: string) => string;
}

export interface MarkdownTheme {
	heading: (text: string) => string;
	code: (text: string) => string;
}

export interface SelectListTheme {
	selected: (text: string) => string;
}

export interface SettingsListTheme {
	label: (text: string) => string;
	value: (text: string) => string;
}

export type ScrollViewScrollbar = "always" | "auto" | "hidden";

export type WheelScrollLines = number | "auto";

/** Provenance of a resource, mirrored from the context module to avoid a cycle. */
export interface ThemeSourceInfo {
	path: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}

/**
 * The visual theme handed to extension code. Terminal themes are no longer
 * loaded, so only the fields referenced by retained code are declared.
 */
export interface Theme {
	name?: string;
	sourcePath?: string;
	sourceInfo?: ThemeSourceInfo;
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

/** Minimal surface of Pi's keybindings manager that extensions reference. */
export interface KeybindingsManager {
	matches(keyId: KeyId, event: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): boolean;
	getBinding(keyId: KeyId): string | undefined;
}

/** A single configurable application keybinding. */
export interface AppKeybinding {
	id: KeyId;
	description: string;
	defaultKeys: string[];
}

export type KeybindingsConfig = Record<KeyId, string[]>;

export interface ImageDimensions {
	width: number;
	height: number;
}

const identity = (text: string): string => text;

/** Passthrough theme used when no renderer is attached. */
export const theme: Theme = {
	fg: identity,
	bg: identity,
	bold: identity,
	dim: identity,
};

export function getThemeByName(_name: string): Theme | undefined {
	return undefined;
}

export function loadThemeFromPath(_path: string, _colorMode?: TerminalColorMode): Theme | undefined {
	return undefined;
}

export function detectCapabilities(_probe?: () => boolean): TerminalCapabilities {
	return { images: null, trueColor: false, hyperlinks: false, colorMode: "none" };
}

export function getTerminalColorMode(_capabilities?: TerminalCapabilities): TerminalColorMode {
	return "none";
}

export function getCapabilities(): TerminalCapabilities {
	return detectCapabilities();
}

export function getImageDimensions(_data: Uint8Array): ImageDimensions | undefined {
	return undefined;
}

/** No terminal supports hyperlinks here, so the label is returned unchanged. */
export function hyperlink(label: string, _url: string): string {
	return label;
}

export function imageFallback(altText: string): string {
	return altText;
}