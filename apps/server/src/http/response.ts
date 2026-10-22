import type { IncomingMessage, ServerResponse } from "node:http";

/** Node 的请求头可能是数组形式，路由只关心第一个值。 */
export function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/**
 * JSON 响应。
 *
 * 不在这里写 CORS 头：`Access-Control-Allow-Origin` 由请求入口按 Origin 白名单回写，
 * 任何位置重新引入 `*` 都会让管理 API 重新向任意网页开口。
 */
export function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}

export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	if (chunks.length === 0) return {};
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export async function binaryBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxBytes) throw new Error("上传文件超过大小限制");
		chunks.push(buffer);
	}
	return new Uint8Array(Buffer.concat(chunks));
}
