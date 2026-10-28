import type { Container } from "@earendil-works/pi-tui";
import { ExplorationGroupComponent, isExplorationToolSnapshot } from "./components/exploration-group.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";

type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

interface ToolExecutionPresenterOptions {
	createComponent: (
		toolName: string,
		toolCallId: string,
		args: unknown,
		argsComplete: boolean,
	) => ToolExecutionComponent;
	toolsExpanded: () => boolean;
	compactExploration: boolean;
}

export class ToolExecutionPresenter {
	private readonly container: Container;
	private readonly createComponent: ToolExecutionPresenterOptions["createComponent"];
	private readonly toolsExpanded: ToolExecutionPresenterOptions["toolsExpanded"];
	private readonly pending = new Map<string, ToolExecutionComponent>();
	private compactExploration: boolean;

	constructor(container: Container, options: ToolExecutionPresenterOptions) {
		this.container = container;
		this.createComponent = options.createComponent;
		this.toolsExpanded = options.toolsExpanded;
		this.compactExploration = options.compactExploration;
	}

	setCompactExploration(enabled: boolean): void {
		this.compactExploration = enabled;
	}

	reset(): void {
		this.pending.clear();
	}

	track(toolName: string, toolCallId: string, args: unknown, argsComplete = false): ToolExecutionComponent {
		let component = this.pending.get(toolCallId);
		if (component) {
			component.updateArgs(args);
			if (argsComplete) component.setArgsComplete();
			this.promoteIfExploration(component);
			this.refreshGroup(component);
			return component;
		}

		component = this.createComponent(toolName, toolCallId, args, argsComplete);
		this.pending.set(toolCallId, component);
		this.addComponent(component);
		return component;
	}

	completePendingArguments(): void {
		for (const component of this.pending.values()) {
			component.setArgsComplete();
			this.promoteIfExploration(component);
			this.refreshGroup(component);
		}
	}

	start(toolName: string, toolCallId: string, args: unknown): void {
		this.track(toolName, toolCallId, args, true).markExecutionStarted();
	}

	update(toolCallId: string, result: ToolResult, isPartial: boolean): void {
		const component = this.pending.get(toolCallId);
		if (!component) return;
		component.updateResult(result, isPartial);
		this.promoteIfExploration(component);
		this.refreshGroup(component);
	}

	finish(toolCallId: string, result: ToolResult): void {
		this.update(toolCallId, result, false);
		this.pending.delete(toolCallId);
	}

	failPending(message: string): void {
		for (const toolCallId of this.pending.keys()) {
			this.finish(toolCallId, {
				content: [{ type: "text", text: message }],
				isError: true,
			});
		}
	}

	setShowImages(show: boolean): void {
		this.forEachComponent((component) => component.setShowImages(show));
	}

	setImageWidthCells(width: number): void {
		this.forEachComponent((component) => component.setImageWidthCells(width));
	}

	private addComponent(component: ToolExecutionComponent): void {
		if (!this.compactExploration || !isExplorationToolSnapshot(component.getPresentationSnapshot())) {
			this.container.addChild(component);
			return;
		}

		const last = this.container.children.at(-1);
		if (last instanceof ExplorationGroupComponent) {
			last.addTool(component);
			return;
		}

		const group = new ExplorationGroupComponent();
		group.setExpanded(this.toolsExpanded());
		group.addTool(component);
		this.container.addChild(group);
	}

	private promoteIfExploration(component: ToolExecutionComponent): void {
		if (!this.compactExploration || !isExplorationToolSnapshot(component.getPresentationSnapshot())) return;
		if (this.findGroup(component)) return;

		const index = this.container.children.indexOf(component);
		if (index === -1) return;

		const previous = this.container.children[index - 1];
		const next = this.container.children[index + 1];
		if (previous instanceof ExplorationGroupComponent) {
			this.container.children.splice(index, 1);
			previous.addTool(component);
			if (next instanceof ExplorationGroupComponent) {
				next.forEachTool((tool) => previous.addTool(tool));
				this.container.removeChild(next);
			}
			return;
		}

		if (next instanceof ExplorationGroupComponent) {
			this.container.children.splice(index, 1);
			next.prependTool(component);
			return;
		}

		const group = new ExplorationGroupComponent();
		group.setExpanded(this.toolsExpanded());
		group.addTool(component);
		this.container.children[index] = group;
	}

	private findGroup(component: ToolExecutionComponent): ExplorationGroupComponent | undefined {
		const toolCallId = component.getPresentationSnapshot().toolCallId;
		return this.container.children.find(
			(child): child is ExplorationGroupComponent =>
				child instanceof ExplorationGroupComponent && child.hasTool(toolCallId),
		);
	}

	private refreshGroup(component: ToolExecutionComponent): void {
		const group = this.findGroup(component);
		if (!group) return;
		if (isExplorationToolSnapshot(component.getPresentationSnapshot())) {
			group.refresh();
			return;
		}
		const tools: ToolExecutionComponent[] = [];
		group.forEachTool((tool) => tools.push(tool));
		this.container.children.splice(this.container.children.indexOf(group), 1, ...tools);
		for (const tool of tools) this.promoteIfExploration(tool);
	}

	private forEachComponent(callback: (component: ToolExecutionComponent) => void): void {
		for (const child of this.container.children) {
			if (child instanceof ExplorationGroupComponent) {
				child.forEachTool(callback);
			} else if (child instanceof ToolExecutionComponent) {
				callback(child);
			}
		}
	}
}
