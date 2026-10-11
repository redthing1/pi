import { type ClassifierModel, type ImageModel, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type ModelRequestPolicy, ModelRuntime } from "../src/core/model-runtime.ts";

describe("session model request policy", () => {
	it.each([{ providerScope: "other" }, { remoteZdr: true }] satisfies ModelRequestPolicy[])(
		"rejects every operation before credentials or network: %j",
		async (policy) => {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const model = runtime.getModel("openai", "gpt-4.1")!;
			const auth = vi.spyOn(runtime, "getAuth");
			const fetch = vi.fn(() => {
				throw new Error("unexpected network");
			});
			const options = { fetch, apiKey: "caller-key", allowModelFallbacks: true };
			const context = { messages: [] };
			const handle = { provider: model.provider, api: model.api, modelId: model.id, id: "fixture-response" };
			const messageResults = await Promise.all([
				runtime.stream(model, context, options, policy).result(),
				runtime.complete(model, context, options, policy),
				runtime.streamSimple(model, context, options, policy).result(),
				runtime.completeSimple(model, context, options, policy),
				runtime.streamDeferred(model, handle, options, policy).result(),
				runtime.fetchDeferred(model, handle, options, policy),
			]);
			for (const result of messageResults)
				expect(result).toMatchObject({
					stopReason: "error",
					errorMessage: expect.stringMatching(/provider scope|ZDR requires/),
				});
			await expect(runtime.cancelDeferred(model, handle, options, policy)).rejects.toThrow(
				/provider scope|ZDR requires/,
			);
			const image: ImageModel<string> = {
				type: "image",
				api: "fixture-image",
				provider: model.provider,
				id: "image",
				name: "image",
				baseUrl: model.baseUrl,
				input: ["text"],
				output: ["image"],
				cost: model.cost,
			};
			const classifier: ClassifierModel<string> = {
				type: "classifier",
				api: "fixture-classifier",
				provider: model.provider,
				id: "classifier",
				name: "classifier",
				baseUrl: model.baseUrl,
				input: ["text"],
				cost: model.cost,
				contextWindow: 1000,
			};
			expect(
				await runtime.generateImages(image, { input: [{ type: "text", text: "circle" }] }, options, policy),
			).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/provider scope|ZDR requires/) });
			expect(
				await runtime.classify(
					classifier,
					{
						state: { text: "yes" },
						questions: {
							accepted: { type: "bool", instructions: "Approval?", criteria: { true: "yes", false: "no" } },
						},
					},
					options,
					policy,
				),
			).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/provider scope|ZDR requires/) });
			expect(auth).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
