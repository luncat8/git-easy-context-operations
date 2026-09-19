/**
 * A scriptable {@link UI} so the interactive flows can be tested without
 * VS Code: queues of answers per prompt type, plus a record of every prompt,
 * message, log line and progress step the controller produced.
 */
import type { AskOptions, ConfirmOptions, FilePickOptions, InputOptions, MessageKind, PickOptions, QuickPickChoice, UI } from '../../core/ui';

export type Answer<T> = T | undefined | (T | undefined)[] | ((callIndex: number) => T | undefined);

export interface UIScript {
	/** Answers for `input()`; a `pick` answer may be an index or an item label. */
	inputs?: Answer<string>;
	picks?: Answer<number | string>;
	confirms?: Answer<boolean>;
	asks?: Answer<string>;
	files?: Answer<string>;
}

export interface PickCall {
	items: readonly { label: string; description?: string }[];
	options?: PickOptions;
	chosenIndex: number;
}

export class FakeUI implements UI {
	readonly inputCalls: InputOptions[] = [];
	readonly pickCalls: PickCall[] = [];
	readonly confirmCalls: { message: string; options?: ConfirmOptions }[] = [];
	readonly askCalls: { message: string; options: AskOptions }[] = [];
	readonly messages: { kind: MessageKind; message: string; detail?: string }[] = [];
	readonly logs: string[] = [];
	readonly progressTitles: string[] = [];
	readonly progressReports: string[] = [];
	readonly copied: string[] = [];
	readonly openedPaths: string[] = [];
	readonly outputReveals: number[] = [];
	private counts = { input: 0, pick: 0, confirm: 0, ask: 0, file: 0 };

	constructor(private readonly script: UIScript = {}) {}

	async input(options: InputOptions): Promise<string | undefined> {
		const index = this.counts.input++;
		this.inputCalls.push(options);
		const answer = resolveAnswer(this.script.inputs, index, options.value);
		return answer;
	}

	async pick<T>(items: readonly QuickPickChoice<T>[], options?: PickOptions): Promise<T | undefined> {
		const index = this.counts.pick++;
		const answer = resolveAnswer(this.script.picks, index, 0);
		let chosenIndex = 0;
		if (typeof answer === 'string') {
			const found = items.findIndex((item) => item.label === answer || item.label.includes(answer));
			chosenIndex = found >= 0 ? found : -1;
		} else if (typeof answer === 'number') {
			chosenIndex = answer;
		}
		this.pickCalls.push({
			items: items.map((item) => ({ label: item.label, description: item.description })),
			options,
			chosenIndex,
		});
		if (chosenIndex < 0 || chosenIndex >= items.length) {
			return undefined;
		}
		return items[chosenIndex]!.value;
	}

	async confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
		const index = this.counts.confirm++;
		this.confirmCalls.push({ message, options });
		return resolveAnswer(this.script.confirms, index, true) ?? false;
	}

	async ask(message: string, options: AskOptions): Promise<string | undefined> {
		const index = this.counts.ask++;
		this.askCalls.push({ message, options });
		return resolveAnswer(this.script.asks, index, undefined);
	}

	async message(kind: MessageKind, message: string, detail?: string): Promise<void> {
		this.messages.push({ kind, message, detail });
	}

	log(message: string): void {
		this.logs.push(message);
	}

	async withProgress<R>(title: string, task: (report: (message: string) => void) => Promise<R>): Promise<R> {
		this.progressTitles.push(title);
		return task((message) => this.progressReports.push(`${title}: ${message}`));
	}

	async copy(text: string): Promise<void> {
		this.copied.push(text);
	}

	async pickFile(options: FilePickOptions): Promise<string | undefined> {
		const index = this.counts.file++;
		void options;
		return resolveAnswer(this.script.files, index, undefined);
	}

	async openPath(path: string): Promise<void> {
		this.openedPaths.push(path);
	}

	async showOutput(): Promise<void> {
		this.outputReveals.push(Date.now());
	}

	/** Every prompt the user saw, in order, as readable text. */
	get transcript(): string {
		const lines: string[] = [];
		for (const call of this.pickCalls) {
			lines.push(`pick[${call.options?.title ?? '?'}] -> ${call.chosenIndex >= 0 ? call.items[call.chosenIndex]?.label : '(cancelled)'}`);
		}
		for (const call of this.inputCalls) {
			lines.push(`input[${call.title ?? '?'}] "${call.prompt}"`);
		}
		for (const call of this.confirmCalls) {
			lines.push(`confirm "${call.message}"`);
		}
		for (const call of this.askCalls) {
			lines.push(`ask "${call.message}" [${call.options.actions.join(', ')}]`);
		}
		return lines.join('\n');
	}

	allMessages(): string {
		return this.messages.map((m) => `${m.kind}: ${m.message}${m.detail ? `\n${m.detail}` : ''}`).join('\n');
	}

	allLogs(): string {
		return this.logs.join('\n');
	}
}

function resolveAnswer<T>(script: Answer<T> | undefined, index: number, fallback: T | undefined): T | undefined {
	if (script === undefined) {
		return fallback;
	}
	if (typeof script === 'function') {
		return (script as (callIndex: number) => T | undefined)(index);
	}
	if (Array.isArray(script)) {
		const value = (script as (T | undefined)[])[index];
		return value === undefined ? fallback : value;
	}
	return script as T;
}
