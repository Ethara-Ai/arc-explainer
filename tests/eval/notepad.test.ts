

import { describe, it, expect } from 'vitest';
import { Notepad } from '../../server/services/eval/runner/notepad';

// ── Basic operations ────────────────────────────────────────────────────────

describe('Notepad basic operations', () => {
  it('starts empty', () => {
    const notepad = new Notepad();
    expect(notepad.read()).toBe('');
    expect(notepad.versionCount).toBe(0);
  });

  it('update replaces content', () => {
    const notepad = new Notepad();
    notepad.update('first version');
    expect(notepad.read()).toBe('first version');
  });

  it('update saves previous version to history', () => {
    const notepad = new Notepad();
    notepad.update('v1');
    expect(notepad.versionCount).toBe(1); // empty '' was saved

    notepad.update('v2');
    expect(notepad.versionCount).toBe(2); // 'v1' was saved
    expect(notepad.read()).toBe('v2');
  });

  it('clear resets content and saves to history', () => {
    const notepad = new Notepad();
    notepad.update('content');
    notepad.clear();

    expect(notepad.read()).toBe('');
    expect(notepad.versionCount).toBe(2); // '' from update, 'content' from clear
  });
});

// ── Truncation ──────────────────────────────────────────────────────────────

describe('Notepad truncation', () => {
  it('default max is 4000 characters', () => {
    const notepad = new Notepad();
    notepad.update('x'.repeat(5000));
    expect(notepad.read()).toHaveLength(4000);
  });

  it('respects custom maxChars', () => {
    const notepad = new Notepad(100);
    notepad.update('a'.repeat(200));
    expect(notepad.read()).toHaveLength(100);
  });

  it('does not truncate when within limit', () => {
    const notepad = new Notepad(1000);
    notepad.update('short content');
    expect(notepad.read()).toBe('short content');
  });

  it('truncates from the end (keeps beginning)', () => {
    const notepad = new Notepad(10);
    notepad.update('abcdefghijklmnop');
    expect(notepad.read()).toBe('abcdefghij');
  });
});

// ── Serialization ───────────────────────────────────────────────────────────

describe('Notepad toState / fromState', () => {
  it('round-trips state correctly', () => {
    const original = new Notepad(2000);
    original.update('v1');
    original.update('v2');
    original.update('v3');

    const state = original.toState();
    expect(state.content).toBe('v3');
    expect(state.maxChars).toBe(2000);
    expect(state.history).toEqual(['', 'v1', 'v2']);

    const restored = Notepad.fromState(state);
    expect(restored.read()).toBe('v3');
    expect(restored.versionCount).toBe(3);
  });

  it('toState returns a copy of history (not reference)', () => {
    const notepad = new Notepad();
    notepad.update('content');

    const state = notepad.toState();
    state.history.push('injected');

    // Original should be unaffected
    expect(notepad.versionCount).toBe(1);
  });

  it('fromState creates independent copy', () => {
    const state = { content: 'hello', maxChars: 4000, history: ['prev'] };
    const restored = Notepad.fromState(state);

    restored.update('new');
    // Original state should be unaffected
    expect(state.history).toEqual(['prev']);
  });

  it('preserves empty state', () => {
    const notepad = new Notepad();
    const state = notepad.toState();
    expect(state.content).toBe('');
    expect(state.maxChars).toBe(4000);
    expect(state.history).toEqual([]);
  });
});

// ── Version counting ────────────────────────────────────────────────────────

describe('Notepad versionCount', () => {
  it('increments on each update', () => {
    const notepad = new Notepad();
    expect(notepad.versionCount).toBe(0);

    notepad.update('a');
    expect(notepad.versionCount).toBe(1);

    notepad.update('b');
    expect(notepad.versionCount).toBe(2);

    notepad.update('c');
    expect(notepad.versionCount).toBe(3);
  });

  it('increments on clear', () => {
    const notepad = new Notepad();
    notepad.update('content');
    expect(notepad.versionCount).toBe(1);

    notepad.clear();
    expect(notepad.versionCount).toBe(2);
  });
});
