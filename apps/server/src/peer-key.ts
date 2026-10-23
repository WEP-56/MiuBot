/**
 * 入站白名单的键：`group:<群 ID>` / `c2c:<用户 ID>`。
 *
 * 与 `peer-configs.json` 里的 `scope` + `peerId` 一致。QQ 的 openid 本来就按 Bot 隔离，
 * 所以键里不再带 botId——同一个群在换 Bot 后 openid 会变，旧键自然失效。
 */
export const PEER_KEY_PATTERN = /^(group|c2c):[A-Za-z0-9_-]{1,64}$/;

export function isPeerKey(value: string): boolean {
	return PEER_KEY_PATTERN.test(value);
}

export function peerKey(scope: "group" | "c2c", peerId: string): string {
	return `${scope}:${peerId}`;
}
