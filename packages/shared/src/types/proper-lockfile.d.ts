declare module "proper-lockfile" {
	export interface LockOptions {
		realpath?: boolean;
		resolveSymlinks?: boolean;
		retries?: number | { retries?: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean };
		stale?: number;
		onCompromised?: (error: Error) => void;
	}
	export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	export function lockSync(file: string, options?: LockOptions & { lockfilePath?: string }): () => void;
	export function unlock(file: string, options?: LockOptions): Promise<void>;
	export function check(file: string, options?: LockOptions): Promise<boolean>;
}