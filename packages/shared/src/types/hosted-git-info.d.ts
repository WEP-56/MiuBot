declare module "hosted-git-info" {
	export interface HostedGitInfo {
		type: string;
		domain: string;
		user: string;
		project: string;
		committish?: string;
		path?: string;
		https(options?: { noGitPlus?: boolean; noCommittish?: boolean }): string | undefined;
		ssh(options?: { noCommittish?: boolean }): string | undefined;
	}
	export function fromUrl(url: string, options?: { noGitPlus?: boolean }): HostedGitInfo | undefined;
}