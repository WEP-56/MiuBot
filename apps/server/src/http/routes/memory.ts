import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerConfig } from "../../agent-host.ts";
import type { MemoryArea, MemoryCategory, MemoryIdentity } from "../../memory.ts";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

function identityFrom(input: Record<string, unknown>): MemoryIdentity | undefined {
	const scope = input.scope;
	const botId = String(input.botId ?? "");
	const peerId = String(input.peerId ?? "");
	if ((scope !== "group" && scope !== "c2c") || !botId || !peerId) return undefined;
	return { botId, scope, peerId };
}

function findPeer(ctx: HttpContext, identity: MemoryIdentity): PeerConfig | undefined {
	return ctx.peers.find(identity.scope, identity.peerId, identity.botId);
}

function readDisplayNames(ctx: HttpContext, identity: MemoryIdentity): Map<string, string> {
	const names = new Map<string, string>();
	for (const session of ctx.sessions.get()) {
		if (session.botId !== identity.botId || session.scope !== identity.scope || session.peerId !== identity.peerId)
			continue;
		for (const message of session.messages) {
			if (!message.sender) continue;
			const match = message.sender.match(/^(.*?)（平台用户 ID\/OpenID: (.+)）$/);
			if (match?.[2]) names.set(match[2], match[1] || match[2]);
		}
	}
	return names;
}

function validArea(value: unknown): value is MemoryArea {
	return value === "shared" || value === "personal";
}

function validCategory(value: unknown): value is MemoryCategory {
	return value === "user" || value === "feedback" || value === "project" || value === "reference";
}

/** 长期记忆管理：对象目录、条目编辑、行为 Prompt 与后台整理。 */
export async function handleMemoryRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname === "/api/memory" && req.method === "GET") {
		const config = ctx.config.get();
		json(res, 200, {
			prompt: config.memoryPrompt,
			peers: ctx.peers.get().map((peer) => ({
				botId: peer.botId,
				botName: config.qqBots.find((bot) => bot.id === peer.botId)?.nickname ?? peer.botId,
				scope: peer.scope,
				peerId: peer.peerId,
				name: peer.name,
				memory: peer.memory,
			})),
		});
		return true;
	}
	if (url.pathname === "/api/memory/prompt" && req.method === "PUT") {
		const input = await body(req);
		if (typeof input.prompt !== "string" || input.prompt.length > 100_000) {
			json(res, 400, { ok: false, message: "长期记忆 Prompt 无效或超过 100,000 个字符" });
			return true;
		}
		ctx.config.get().memoryPrompt = input.prompt;
		await ctx.config.save();
		json(res, 200, { ok: true, prompt: input.prompt });
		return true;
	}
	if (url.pathname === "/api/memory/document" && req.method === "GET") {
		const identity = identityFrom(Object.fromEntries(url.searchParams.entries()));
		if (!identity) {
			json(res, 400, { ok: false, message: "缺少 Bot、对象类型或对象 OpenID" });
			return true;
		}
		if (!findPeer(ctx, identity)) {
			json(res, 404, { ok: false, message: "对象不存在" });
			return true;
		}
		const document = await ctx.memory.read(identity);
		const names = readDisplayNames(ctx, identity);
		json(res, 200, {
			...document,
			entries: document.entries.map((entry) => ({
				...entry,
				...(entry.ownerOpenId ? { memberName: names.get(entry.ownerOpenId) ?? entry.memberName ?? "未知" } : {}),
			})),
		});
		return true;
	}
	if (url.pathname === "/api/memory/document" && req.method === "DELETE") {
		const identity = identityFrom(await body(req));
		if (!identity || !findPeer(ctx, identity)) {
			json(res, 404, { ok: false, message: "对象不存在" });
			return true;
		}
		const peer = findPeer(ctx, identity);
		if (peer) ctx.memoryDream.cancel(peer);
		await ctx.memory.clear(identity);
		json(res, 200, { ok: true });
		return true;
	}
	if (url.pathname === "/api/memory/entry" && req.method === "PUT") {
		const input = await body(req);
		const identity = identityFrom(input);
		if (!identity || !findPeer(ctx, identity)) {
			json(res, 404, { ok: false, message: "对象不存在" });
			return true;
		}
		if (
			!validArea(input.area) ||
			!validCategory(input.category) ||
			typeof input.title !== "string" ||
			typeof input.content !== "string"
		) {
			json(res, 400, { ok: false, message: "记忆条目字段无效" });
			return true;
		}
		if (input.id !== undefined && typeof input.id !== "string") {
			json(res, 400, { ok: false, message: "记忆条目 ID 无效" });
			return true;
		}
		if (input.ownerOpenId !== undefined && typeof input.ownerOpenId !== "string") {
			json(res, 400, { ok: false, message: "成员 OpenID 无效" });
			return true;
		}
		if (input.memberName !== undefined && typeof input.memberName !== "string") {
			json(res, 400, { ok: false, message: "成员名称无效" });
			return true;
		}
		try {
			const entry = await ctx.memory.upsertAdmin(identity, {
				id: String(input.id ?? ""),
				area: input.area,
				category: input.category,
				title: input.title,
				content: input.content,
				...(typeof input.ownerOpenId === "string" && input.ownerOpenId ? { ownerOpenId: input.ownerOpenId } : {}),
				...(typeof input.memberName === "string" && input.memberName ? { memberName: input.memberName } : {}),
			});
			json(res, 200, { ok: true, entry });
		} catch (error) {
			json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	if (url.pathname === "/api/memory/entry" && req.method === "DELETE") {
		const input = await body(req);
		const identity = identityFrom(input);
		const id = typeof input.id === "string" ? input.id : "";
		if (!identity || !findPeer(ctx, identity) || !id) {
			json(res, 404, { ok: false, message: "对象或记忆条目不存在" });
			return true;
		}
		try {
			await ctx.memory.deleteEntry(identity, id);
			json(res, 200, { ok: true });
		} catch (error) {
			json(res, 404, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	if (url.pathname === "/api/memory/dream" && req.method === "POST") {
		const identity = identityFrom(await body(req));
		const peer = identity ? findPeer(ctx, identity) : undefined;
		if (!peer) {
			json(res, 404, { ok: false, message: "对象不存在" });
			return true;
		}
		if (!peer.memory.enabled) {
			json(res, 400, { ok: false, message: "请先为对象启用长期记忆" });
			return true;
		}
		try {
			await ctx.memoryDream.runNow(peer);
			json(res, 200, { ok: true, memory: peer.memory });
		} catch (error) {
			json(res, 400, {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
				memory: peer.memory,
			});
		}
		return true;
	}
	return false;
}
