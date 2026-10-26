import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { stream as streamCompletions, streamSimple as streamSimpleCompletions } from "../src/api/openai-completions.ts";
import { generateImages } from "../src/api/openrouter-images.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { FetchFunction, ImageModel, Model, ProviderHeaders } from "../src/types.ts";
import {
	type ClientIdentity,
	formatUserAgent,
	getAttributionHeaders,
	getIdentityHeaders,
	mergeClientIdentity,
	PI_ATTRIBUTION,
	withClientIdentity,
} from "../src/utils/identity.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { PI_AI_VERSION } from "../src/utils/version.ts";

const ACME = { name: "acme", url: "https://acme.example" };

const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;

function target(provider: string, baseUrl: string) {
	return { provider, baseUrl };
}

function completionsModel(provider: string, baseUrl: string, headers?: Record<string, string>) {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(headers ? { headers } : {}),
	} satisfies Model<"openai-completions">;
}

function capturingFetch(responseBody?: string): { fetch: FetchFunction; headers: () => Headers } {
	let captured: Headers | undefined;
	const fetch: FetchFunction = async (input, init) => {
		captured = new Request(input, init).headers;
		const chunks = [
			{ id: "chatcmpl-identity", choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }] },
			{
				id: "chatcmpl-identity",
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			},
		];
		const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
		return new Response(responseBody ?? body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return {
		fetch,
		headers: () => {
			if (!captured) throw new Error("no request was sent");
			return captured;
		},
	};
}

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

describe("client identity", () => {
	it("keeps the version constant in sync with package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		expect(PI_AI_VERSION).toBe(pkg.version);
	});

	it("formats user agents", () => {
		expect(formatUserAgent()).toBe(`pi/${PI_AI_VERSION} (${process.platform}; ${runtime}; ${process.arch})`);
		expect(formatUserAgent({ version: "9.9.9" })).toBe(`pi/9.9.9 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(formatUserAgent({ userAgent: "short", version: "9.9.9" })).toBe("pi");
		expect(formatUserAgent({ userAgent: { custom: "acme/1.0" } })).toBe("acme/1.0");
	});

	it("merges identities field by field", () => {
		expect(mergeClientIdentity(undefined, undefined)).toBeUndefined();
		expect(
			mergeClientIdentity(
				{ attribution: PI_ATTRIBUTION, userAgent: "short" },
				{ attribution: undefined, version: "1.0.0" },
			),
		).toEqual({ attribution: PI_ATTRIBUTION, userAgent: "short", version: "1.0.0" });
		expect(mergeClientIdentity({ attribution: PI_ATTRIBUTION }, { attribution: null })).toEqual({
			attribution: null,
		});
	});

	it("sends no attribution unless enabled", () => {
		const openRouter = target("openrouter", "https://openrouter.ai/api/v1");
		expect(getAttributionHeaders(openRouter)).toEqual({});
		expect(getAttributionHeaders(openRouter, { attribution: null })).toEqual({});
		expect(getIdentityHeaders(openRouter)).toMatchObject({ "User-Agent": null, "X-Stainless-Runtime-Version": null });
	});

	it("attributes OpenRouter requests", () => {
		const openRouter = target("openrouter", "https://openrouter.ai/api/v1");
		expect(getAttributionHeaders(openRouter, { attribution: PI_ATTRIBUTION })).toEqual({
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		});
		expect(
			getAttributionHeaders(openRouter, {
				attribution: { ...ACME, categories: ["cli-agent", "cloud-agent"] },
			}),
		).toEqual({
			"HTTP-Referer": "https://acme.example",
			"X-OpenRouter-Title": "acme",
			"X-OpenRouter-Categories": "cli-agent,cloud-agent",
		});
		expect(getAttributionHeaders(openRouter, { attribution: { ...ACME, categories: [] } })).toEqual({
			"HTTP-Referer": "https://acme.example",
			"X-OpenRouter-Title": "acme",
		});
		// Custom providers routed through OpenRouter, including legacy base URLs that are not valid URLs.
		expect(
			getAttributionHeaders(target("custom", "not-a-url-openrouter.ai"), { attribution: PI_ATTRIBUTION }),
		).toMatchObject({ "X-OpenRouter-Title": "pi" });
	});

	it("attributes NVIDIA NIM requests with a capitalized name and OpenCode requests with the name", () => {
		expect(
			getAttributionHeaders(target("nvidia", "https://example.test/v1"), { attribution: PI_ATTRIBUTION }),
		).toEqual({
			"X-BILLING-INVOKE-ORIGIN": "Pi",
		});
		expect(
			getAttributionHeaders(target("custom-nim", "https://integrate.api.nvidia.com/v1"), { attribution: ACME }),
		).toEqual({ "X-BILLING-INVOKE-ORIGIN": "Acme" });
		expect(
			getAttributionHeaders(target("opencode", "https://opencode.ai/zen/v1"), { attribution: PI_ATTRIBUTION }),
		).toEqual({
			"x-opencode-client": "pi",
		});
		expect(getAttributionHeaders(target("custom", "https://opencode.ai/zen/v1"), { attribution: ACME })).toEqual({
			"x-opencode-client": "acme",
		});
	});

	it("does not attribute NVIDIA models routed through gateways to NVIDIA", () => {
		expect(
			getAttributionHeaders(target("openrouter", "https://openrouter.ai/api/v1"), { attribution: PI_ATTRIBUTION }),
		).not.toHaveProperty("X-BILLING-INVOKE-ORIGIN");
		expect(
			getAttributionHeaders(target("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1"), {
				attribution: PI_ATTRIBUTION,
			}),
		).toEqual({});
	});
});

describe("client identity in requests", () => {
	it("uses the same privacy defaults for OpenRouter image requests", async () => {
		let headers: Headers | undefined;
		const model: ImageModel<"openrouter-images"> = {
			...completionsModel("openrouter", "https://example.test/v1"),
			type: "image",
			api: "openrouter-images",
			output: ["image"],
		};
		const result = await generateImages(
			model,
			{ input: [{ type: "text", text: "synthetic image" }] },
			{
				apiKey: "key",
				fetch: async (input, init) => {
					headers = new Request(input, init).headers;
					return Response.json({
						id: "image",
						choices: [{ message: { images: [{ image_url: "data:image/png;base64,c3ludGhldGlj" }] } }],
					});
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(result.output).toHaveLength(1);
		expect(headers?.get("authorization")).toBe("Bearer key");
		expect([...headers!.keys()].filter((name) => name.startsWith("x-stainless-"))).toEqual([]);
		for (const name of ["user-agent", "http-referer", "x-openrouter-title", "x-openrouter-categories"]) {
			expect(headers?.has(name), name).toBe(false);
		}
	});

	it("preserves Anthropic protocol headers without optional SDK metadata", async () => {
		const events = [
			{
				type: "message_start",
				message: {
					id: "test",
					type: "message",
					role: "assistant",
					model: "test",
					content: [],
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
		const capture = capturingFetch(
			events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		);
		const model = { ...completionsModel("anthropic", "https://example.test"), api: "anthropic-messages" } as const;
		const result = await streamAnthropic(model, context, { apiKey: "key", fetch: capture.fetch }).result();
		expect(result.stopReason).toBe("stop");
		expect(capture.headers().has("anthropic-version")).toBe(true);
		expect(capture.headers().get("x-api-key")).toBe("key");
		expect([...capture.headers().keys()].filter((name) => name.startsWith("x-stainless-"))).toEqual([]);
		expect(capture.headers().has("user-agent")).toBe(false);
	});

	it.each(["google-generative-ai", "google-vertex"] as const)(
		"keeps %s SDK metadata generic and honors explicit headers",
		async (api) => {
			const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`;
			const send = api === "google-generative-ai" ? streamGoogle : streamVertex;
			for (const headers of [
				undefined,
				{ "user-agent": "explicit-agent", "X-Goog-Api-Client": "explicit-client" },
			]) {
				const capture = capturingFetch(body);
				vi.stubGlobal("fetch", capture.fetch);
				try {
					const model = { ...completionsModel(api, "https://example.test/v1"), api };
					const result = await send(model as never, context, { apiKey: "key", headers }).result();
					expect(result.stopReason).toBe("stop");
					expect(capture.headers().get("user-agent")).toBe(headers?.["user-agent"] ?? "");
					expect(capture.headers().get("x-goog-api-client")).toBe(headers?.["X-Goog-Api-Client"] ?? "");
					expect(capture.headers().get("x-goog-api-key")).toBe("key");
				} finally {
					vi.unstubAllGlobals();
				}
			}
		},
	);

	it("omits optional client and SDK fingerprints from outgoing requests by default", async () => {
		const capture = capturingFetch();
		const result = await streamCompletions(completionsModel("openrouter", "https://example.test/v1"), context, {
			apiKey: "key",
			fetch: capture.fetch,
		}).result();
		expect(result.stopReason).toBe("stop");
		const headers = capture.headers();
		expect([...headers.keys()].filter((name) => name.startsWith("x-stainless-"))).toEqual([]);
		for (const name of ["user-agent", "http-referer", "x-openrouter-title", "x-openrouter-categories"]) {
			expect(headers.has(name), name).toBe(false);
		}
	});

	it("applies the identity below model and request headers", async () => {
		const capture = capturingFetch();
		const model = completionsModel("openrouter", "https://openrouter.ai/api/v1", {
			"X-OpenRouter-Title": "model-title",
		});
		await streamCompletions(model, context, {
			apiKey: "key",
			fetch: capture.fetch,
			identity: { attribution: PI_ATTRIBUTION, userAgent: "short" },
			headers: { "HTTP-Referer": null } as ProviderHeaders,
		}).result();

		const headers = capture.headers();
		expect(headers.get("user-agent")).toBe("pi");
		expect(headers.get("x-openrouter-title")).toBe("model-title");
		expect(headers.has("http-referer")).toBe(false);
	});

	it("keeps impersonating model headers over the identity User-Agent", async () => {
		const capture = capturingFetch();
		const model = completionsModel("github-copilot", "https://api.githubcopilot.com", {
			"User-Agent": "GitHubCopilotChat/0.35.0",
		});
		await streamCompletions(model, context, {
			apiKey: "key",
			fetch: capture.fetch,
			identity: { userAgent: { custom: "acme" } },
		}).result();

		expect(capture.headers().get("user-agent")).toBe("GitHubCopilotChat/0.35.0");
	});

	it("merges request identity over the Models and wrapper identities", async () => {
		const model = completionsModel("openrouter", "https://openrouter.ai/api/v1");
		const attribution = (name: string) => ({ name, url: "https://acme.example" });
		const models = createModels({ identity: { attribution: attribution("models"), userAgent: "short" } });
		models.setProvider(
			createProvider({
				id: "openrouter",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [model],
				api: { stream: streamCompletions, streamSimple: streamSimpleCompletions },
			}),
		);
		const send = async (target: typeof models, identity?: ClientIdentity) => {
			const capture = capturingFetch();
			await target.streamSimple(model, context, { fetch: capture.fetch, identity }).result();
			return capture.headers();
		};

		const fromModels = await send(models);
		expect(fromModels.get("user-agent")).toBe("pi");
		expect(fromModels.get("x-openrouter-title")).toBe("models");

		const wrapped = withClientIdentity(models, { attribution: attribution("wrapper") });
		const fromWrapper = await send(wrapped);
		expect(fromWrapper.get("user-agent")).toBe("pi");
		expect(fromWrapper.get("x-openrouter-title")).toBe("wrapper");
		expect(wrapped.getModel("openrouter", "test-model")).toBe(model);
		// A MutableModels stays mutable.
		wrapped.deleteProvider("openrouter");
		expect(models.getProvider("openrouter")).toBeUndefined();
		models.setProvider(
			createProvider({
				id: "openrouter",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [model],
				api: { stream: streamCompletions, streamSimple: streamSimpleCompletions },
			}),
		);

		const fromRequest = await send(wrapped, { attribution: null });
		expect(fromRequest.has("x-openrouter-title")).toBe(false);
		expect(fromRequest.get("user-agent")).toBe("pi");
	});

	it("sends the OpenCode session header to custom providers pointing at OpenCode", async () => {
		const model = completionsModel("custom-opencode", "https://opencode.ai/zen/v1");
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "custom-opencode",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [model],
				api: { stream: streamCompletions, streamSimple: streamSimpleCompletions },
			}),
		);
		const send = async (headers?: ProviderHeaders) => {
			const capture = capturingFetch();
			await models.streamSimple(model, context, { fetch: capture.fetch, sessionId: "session-1", headers }).result();
			return capture.headers();
		};

		expect((await send()).get("x-opencode-session")).toBe("session-1");
		expect((await send({ "X-OpenCode-Session": "configured" })).get("x-opencode-session")).toBe("configured");
	});
});
