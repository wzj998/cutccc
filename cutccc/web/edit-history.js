// Project edits only: media files and server revision numbers are never rolled back.
export class EditHistory {
  constructor(limit = 100, maxBytes = 16 * 1024 * 1024) {
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.reset(null);
  }
  reset(value) {
    this.current = this.saved = JSON.stringify(value);
    this.past = [];
    this.future = [];
    this.breakGroup();
  }
  breakGroup() { this.group = null; this.lastAt = 0; }
  trim(stack) {
    let bytes = stack.reduce((sum, item) => sum + item.length * 2, 0);
    while (stack.length > this.limit || (bytes > this.maxBytes && stack.length > 1))
      bytes -= stack.shift().length * 2;
  }
  record(value, {group = null, at = Date.now()} = {}) {
    const next = JSON.stringify(value);
    if (next === this.current) return false;
    if (!group || this.group !== group || at - this.lastAt > 800 || !this.past.length) {
      this.past.push(this.current);
      this.trim(this.past);
    }
    this.current = next;
    this.future = [];
    this.group = group;
    this.lastAt = at;
    return true;
  }
  markSaved(value) { this.saved = JSON.stringify(value); this.breakGroup(); }
  get dirty() { return this.current !== this.saved; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  undo() {
    if (!this.canUndo) return null;
    this.future.push(this.current);
    this.trim(this.future);
    this.current = this.past.pop();
    this.breakGroup();
    return JSON.parse(this.current);
  }
  redo() {
    if (!this.canRedo) return null;
    this.past.push(this.current);
    this.trim(this.past);
    this.current = this.future.pop();
    this.breakGroup();
    return JSON.parse(this.current);
  }
}
