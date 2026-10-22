import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerConfig } from "../../agent-host.ts";
import type { HttpContext } from "../context.ts";
import { publicSession } from "../present.ts";
import { body, json } from "../response.ts";

function peerLabel(scope: string, peerId: string): string {
	return `${scope === "group" ? "群" : "用户"} ${peerId}`;
}

/** 群/个人对象与「按对象」配置，以及会话的增删改查。 */
export async function handleSessionRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();

	if (url.pathname === "/api/peers" && req.method === "GET") {
		json(res, 200, { peers: ctx.peers.get() });
		return true;
	}
	if (url.pathname === "/api/peers" && req.method === "POST") {
		const input = await body(req);
		const scope = input.scope;
		const peerId = String(input.peerId ?? "").trim();
		const botId = String(input.botId ?? "");
		const bot = config.qqBots.find((item) => item.id === botId);
		if ((scope !== "group" && scope !== "c2c") || !peerId || !bot) {
			json(res, 400, { ok: false, message: "请选择 Bot、对象类型并填写平台对象 ID/OpenID" });
			return true;
		}
		if (ctx.peers.find(scope, peerId, botId)) {
			json(res, 409, { ok: false, message: "该对象已存在" });
			return true;
		}
		const peer = ctx.peers.ensure(scope, peerId, botId, String(input.name ?? "").trim() || peerLabel(scope, peerId));
		ctx.peers.get().push(peer);
		await ctx.peers.save();
		json(res, 201, { ok: true, peer, peers: ctx.peers.get() });
		return true;
	}
	const peerMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/([^/]+)\/([^/]+)$/);
	if (peerMatch && req.method === "DELETE") {
		const botId = decodeURIComponent(peerMatch[1]!);
		const scope = peerMatch[2];
		const peerId = decodeURIComponent(peerMatch[3]!);
		if (scope !== "group" && scope !== "c2c") {
			json(res, 400, { ok: false, message: "对象类型无效" });
			return true;
		}
		const index = ctx.peers
			.get()
			.findIndex((item) => item.botId === botId && item.scope === scope && item.peerId === peerId);
		if (index < 0) {
			json(res, 404, { ok: false, message: "对象不存在" });
			return true;
		}
		ctx.peers.get().splice(index, 1);
		ctx.agentHost.disposePeer(botId, scope, peerId, ctx.sessions.get());
		ctx.sessions.replace(
			ctx.sessions.get().filter((item) => item.botId !== botId || item.scope !== scope || item.peerId !== peerId),
		);
		await ctx.peers.save();
		await ctx.sessions.save();
		json(res, 200, { ok: true });
		return true;
	}

	if (url.pathname === "/api/peer-config" && (req.method === "GET" || req.method === "PUT")) {
		const input = req.method === "PUT" ? await body(req) : Object.fromEntries(url.searchParams.entries());
		const scope = input.scope;
		const peerId = String(input.peerId ?? "");
		const botId = String(input.botId ?? "");
		if ((scope !== "group" && scope !== "c2c") || !peerId || !botId) {
			json(res, 400, { ok: false, message: "缺少群/个人对象信息" });
			return true;
		}
		const current = ctx.peers.find(scope, peerId, botId);
		if (req.method === "GET") {
			json(res, 200, {
				config: current ?? ctx.peers.ensure(scope, peerId, botId, peerLabel(scope, peerId)),
				personas: config.personas,
				providers: config.providers
					.filter((item) => item.enabled && item.apiKey)
					.map(({ id, name, models }) => ({
						id,
						name,
						models: models.map(({ id: modelId, name: modelName }) => ({ id: modelId, name: modelName })),
					})),
			});
			return true;
		}
		const personaId = String(input.personaId ?? "");
		const providerId = String(input.providerId ?? "");
		const modelId = String(input.modelId ?? "");
		const persona = config.personas.find((item) => item.id === personaId);
		const provider = config.providers.find((item) => item.id === providerId && item.enabled && item.apiKey);
		if (!persona || !provider || !provider.models.some((item) => item.id === modelId)) {
			json(res, 400, { ok: false, message: "请选择有效的人格、已启用提供商和模型" });
			return true;
		}
		const rawFeatures =
			typeof input.features === "object" && input.features !== null
				? (input.features as Record<string, unknown>)
				: {};
		const next: PeerConfig = {
			botId,
			scope,
			peerId,
			name: String(input.name ?? current?.name ?? peerLabel(scope, peerId)).trim() || peerLabel(scope, peerId),
			personaId,
			providerId,
			modelId,
			useTools: input.useTools !== false,
			features: { activeReply: rawFeatures.activeReply === true },
		};
		const index = ctx.peers
			.get()
			.findIndex((item) => item.scope === scope && item.peerId === peerId && item.botId === botId);
		if (index >= 0) ctx.peers.get()[index] = next;
		else ctx.peers.get().push(next);
		await ctx.peers.save();
		for (const session of ctx.sessions.get())
			if (session.scope === scope && session.peerId === peerId && session.botId === botId) {
				ctx.agentHost.applyPeerConfigToSession(session, next);
				await ctx.sessions.save();
			}
		ctx.agentHost.applyToolSettings();
		ctx.log("INFO", `已更新${scope === "group" ? "群聊" : "个人"}配置：${peerId}`);
		json(res, 200, { ok: true, config: next });
		return true;
	}

	if (url.pathname === "/api/sessions" && req.method === "GET") {
		json(res, 200, { sessions: ctx.sessions.get().map(publicSession), peers: ctx.peers.get() });
		return true;
	}
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const input = await body(req);
		const scope = input.scope;
		const peerId = String(input.peerId ?? "");
		const botId = String(input.botId ?? "");
		if (scope !== "group" && scope !== "c2c") {
			json(res, 400, { ok: false, message: "对象类型无效" });
			return true;
		}
		const peer = ctx.peers.find(scope, peerId, botId);
		if (!peer) {
			json(res, 404, { ok: false, message: "对象不存在" });
			return true;
		}
		const session = ctx.sessions.create(scope, peerId, peer.name, botId);
		ctx.agentHost.applyPeerConfigToSession(session, peer);
		await ctx.sessions.save();
		json(res, 201, { ok: true, session: publicSession(session) });
		return true;
	}
	const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (sessionMatch && req.method === "GET") {
		const id = decodeURIComponent(sessionMatch[1] ?? "");
		const session = ctx.sessions.get().find((item) => item.id === id);
		json(res, session ? 200 : 404, session ? { session } : { ok: false, message: "会话不存在" });
		return true;
	}
	if (sessionMatch && req.method === "PUT") {
		const id = decodeURIComponent(sessionMatch[1] ?? "");
		const session = ctx.sessions.get().find((item) => item.id === id);
		if (!session) {
			json(res, 404, { ok: false, message: "会话不存在" });
			return true;
		}
		const input = await body(req);
		if (typeof input.title === "string") session.title = input.title.trim() || session.title;
		if (typeof input.active === "boolean") {
			for (const other of ctx.sessions.get())
				if (other.scope === session.scope && other.peerId === session.peerId && other.botId === session.botId)
					other.active = other.id === session.id && input.active;
			session.active = input.active;
		}
		await ctx.sessions.save();
		json(res, 200, { session });
		return true;
	}
	if (sessionMatch && req.method === "DELETE") {
		const id = decodeURIComponent(sessionMatch[1] ?? "");
		const session = ctx.sessions.get().find((item) => item.id === id);
		if (!session) {
			json(res, 404, { ok: false, message: "会话不存在" });
			return true;
		}
		ctx.sessions.replace(ctx.sessions.get().filter((item) => item.id !== id));
		ctx.agentHost.disposeSession(id);
		await ctx.sessions.save();
		json(res, 200, {
			ok: true,
			remainingPeerSessions: ctx.sessions
				.get()
				.filter(
					(item) => item.botId === session.botId && item.scope === session.scope && item.peerId === session.peerId,
				).length,
		});
		return true;
	}
	return false;
}
