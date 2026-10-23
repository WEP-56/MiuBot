import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { binaryBody, body, DEFAULT_JSON_MAX_BYTES, HttpError } from "../src/http/response.ts";

/** 用可读流冒充请求体：这里只关心上限与解析，不关心真实 socket。 */
function fakeRequest(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
	const stream = Readable.from(chunks) as unknown as IncomingMessage;
	Object.assign(stream, { headers });
	return stream;
}

describe("JSON body", () => {
	it("parses an object payload", async () => {
		const parsed = await body(fakeRequest([Buffer.from('{"name":"miu"}')]));
		expect(parsed).toEqual({ name: "miu" });
	});

	it("treats an empty body as an empty object", async () => {
		expect(await body(fakeRequest([]))).toEqual({});
	});

	it("rejects non-object JSON instead of leaking a primitive upward", async () => {
		expect(await body(fakeRequest([Buffer.from("42")]))).toEqual({});
		expect(await body(fakeRequest([Buffer.from('"text"')]))).toEqual({});
	});

	it("rejects malformed JSON as 400", async () => {
		await expect(body(fakeRequest([Buffer.from("{not json")]))).rejects.toBeInstanceOf(HttpError);
		await expect(body(fakeRequest([Buffer.from("{not json")]))).rejects.toMatchObject({ status: 400 });
	});

	it("enforces the default 1 MB cap while streaming", async () => {
		const oversized = Buffer.alloc(DEFAULT_JSON_MAX_BYTES + 1, 0x61);
		await expect(body(fakeRequest([oversized]))).rejects.toMatchObject({ status: 413 });
	});

	it("rejects on a declared oversized content-length before reading", async () => {
		const request = fakeRequest([Buffer.from("{}")], { "content-length": String(DEFAULT_JSON_MAX_BYTES + 1) });
		await expect(body(request)).rejects.toMatchObject({ status: 413 });
	});

	it("accepts a payload exactly at a custom cap and rejects one byte more", async () => {
		const payload = '{"a":1}';
		expect(await body(fakeRequest([Buffer.from(payload)]), { maxBytes: payload.length })).toEqual({ a: 1 });
		await expect(body(fakeRequest([Buffer.from(payload)]), { maxBytes: payload.length - 1 })).rejects.toMatchObject({
			status: 413,
		});
	});
});

describe("binary body", () => {
	it("returns the raw bytes under the cap", async () => {
		const bytes = await binaryBody(fakeRequest([Buffer.from([1, 2, 3])]), 10);
		expect([...bytes]).toEqual([1, 2, 3]);
	});

	it("rejects uploads over the cap as 413", async () => {
		await expect(binaryBody(fakeRequest([Buffer.alloc(64, 1)]), 32)).rejects.toMatchObject({ status: 413 });
	});
});
