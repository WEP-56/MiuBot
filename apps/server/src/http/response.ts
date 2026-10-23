import type { IncomingMessage, ServerResponse } from "node:http";

/** JSON 请求体上限：管理面最大的合法载荷是整份配置，1 MB 足够且能挡住内存打满。 */
export const DEFAULT_JSON_MAX_BYTES = 1024 * 1024;

/** 带状态码的错误：请求入口按它回状态，而不是一律 500。 */
export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

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

/**
 * 读取 JSON 请求体。
 *
 * 有上限：无上限的 `for await` 会让一个超大请求把整个进程的内存吃满，
 * 而管理 API 是暴露在公网上的那一个。
 */
export async function body(
	req: IncomingMessage,
	options: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
	const maxBytes = options.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
	const limit = `请求体超过 ${formatBytes(maxBytes)} 上限`;
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, limit);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxBytes) throw new HttpError(413, limit);
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "请求体不是合法 JSON");
	}
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export async function binaryBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxBytes) throw new HttpError(413, `上传文件超过 ${formatBytes(maxBytes)} 上限`);
		chunks.push(buffer);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}
