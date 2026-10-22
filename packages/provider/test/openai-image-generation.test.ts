import { describe, expect, it, vi } from "vitest";
import { generateOpenAIImage } from "../src/openai-image-generation.ts";

const invalid = (message = "invalid image generation request") =>
	new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: "invalid_field_value" } }), {
		status: 400,
	});

describe("generateOpenAIImage", () => {
	it("calls the OpenAI images generations endpoint and accepts Base64 output", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 }));
		const result = await generateOpenAIImage({
			apiKey: "secret",
			model: "gpt-image-1",
			prompt: "A blue cat",
			size: "1024x1024",
			quality: "high",
			fetch: fetcher,
		});

		expect(fetcher).toHaveBeenCalledWith(
			"https://api.openai.com/v1/images/generations",
			expect.objectContaining({
				method: "POST",
				headers: { authorization: "Bearer secret", "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-image-1",
					prompt: "A blue cat",
					n: 1,
					size: "1024x1024",
					quality: "high",
				}),
			}),
		);
		expect(result).toEqual({ data: "aW1hZ2U=", mimeType: "image/png" });
	});

	it("accepts the standard URL response and reports API errors", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ url: "https://images.example/generated.png" }] }), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "invalid model" } }), { status: 401 }));

		expect(
			await generateOpenAIImage({ apiKey: "secret", model: "dall-e-3", prompt: "A blue cat", fetch: fetcher }),
		).toEqual({ url: "https://images.example/generated.png" });
		await expect(
			generateOpenAIImage({ apiKey: "secret", model: "missing", prompt: "A blue cat", fetch: fetcher }),
		).rejects.toThrow("invalid model");
	});

	it("drops quality then size when the server rejects optional fields", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(invalid())
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ url: "https://images.example/ok.png" }] }), { status: 200 }),
			);

		const result = await generateOpenAIImage({
			apiKey: "secret",
			model: "moss-image-base-1.0",
			prompt: "A blue cat",
			size: "1024x1024",
			quality: "high",
			fetch: fetcher,
		});

		expect(result).toEqual({ url: "https://images.example/ok.png" });
		const bodies = fetcher.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
		expect(bodies).toEqual([
			{ model: "moss-image-base-1.0", prompt: "A blue cat", n: 1, size: "1024x1024", quality: "high" },
			{ model: "moss-image-base-1.0", prompt: "A blue cat", n: 1, size: "1024x1024" },
		]);
	});

	it("retries with prompt only and surfaces the final error", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => invalid());

		await expect(
			generateOpenAIImage({
				apiKey: "secret",
				model: "moss-image-base-1.0",
				prompt: "A blue cat",
				size: "1024x1024",
				quality: "high",
				fetch: fetcher,
			}),
		).rejects.toThrow("invalid image generation request");

		const bodies = fetcher.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
		expect(bodies).toEqual([
			{ model: "moss-image-base-1.0", prompt: "A blue cat", n: 1, size: "1024x1024", quality: "high" },
			{ model: "moss-image-base-1.0", prompt: "A blue cat", n: 1, size: "1024x1024" },
			{ model: "moss-image-base-1.0", prompt: "A blue cat", n: 1 },
		]);
	});

	it("never sends the auto literals", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ data: [{ url: "https://images.example/ok.png" }] }), { status: 200 }),
			);

		await generateOpenAIImage({
			apiKey: "secret",
			model: "moss-image-base-1.0",
			prompt: "A blue cat",
			size: "auto",
			quality: "auto",
			fetch: fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
			model: "moss-image-base-1.0",
			prompt: "A blue cat",
			n: 1,
		});
	});

	it("does not retry non-validation failures", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }));

		await expect(
			generateOpenAIImage({
				apiKey: "secret",
				model: "moss-image-base-1.0",
				prompt: "A blue cat",
				size: "1024x1024",
				fetch: fetcher,
			}),
		).rejects.toThrow("rate limited");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
