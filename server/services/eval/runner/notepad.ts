import type { NotepadState } from '@shared/eval-types';

export class Notepad {
  private content: string = '';
  private readonly maxChars: number;
  private history: string[] = [];

  constructor(maxChars: number = 8000) {
    this.maxChars = maxChars;
  }

  /** Return current notepad contents. */
  read(): string {
    return this.content;
  }

  /** Replace notepad contents (saves previous version to history). */
  update(newContent: string): void {
    this.history.push(this.content);
    this.content = newContent.slice(0, this.maxChars);
  }

  /** Clear notepad (saves previous version to history). */
  clear(): void {
    this.history.push(this.content);
    this.content = '';
  }

  /** Number of previous versions saved. */
  get versionCount(): number {
    return this.history.length;
  }

  /** Serialize to NotepadState for provider calls. */
  toState(): NotepadState {
    return {
      content: this.content,
      maxChars: this.maxChars,
      history: [...this.history],
    };
  }

  /** Restore from a NotepadState snapshot. */
  static fromState(state: NotepadState): Notepad {
    const notepad = new Notepad(state.maxChars);
    notepad.content = state.content;
    notepad.history = [...state.history];
    return notepad;
  }
}
