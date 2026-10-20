declare module "semver" {
	export interface SemVer {
		raw: string;
		major: number;
		minor: number;
		patch: number;
	}
	export function parse(version: string): SemVer | null;
	export function valid(version: string): string | null;
	export function satisfies(version: string, range: string): boolean;
	export function gte(a: string, b: string): boolean;
	export function gt(a: string, b: string): boolean;
	export function lt(a: string, b: string): boolean;
	export function compare(a: string, b: string): number;
	export function coerce(version: string): SemVer | null;
	export function maxSatisfying(versions: string[], range: string): string | null;
	export function validRange(range: string): string | null;
	export function rcompare(a: string, b: string): number;
	export function minVersion(range: string): SemVer | null;
}