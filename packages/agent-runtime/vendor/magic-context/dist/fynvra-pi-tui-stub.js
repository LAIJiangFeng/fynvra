// Fynvra host stub for @earendil-works/pi-tui.
//
// The Magic Context bundle imports the Pi terminal UI only for its /ctx-status
// dialog and entry renderer. Fynvra never shows the Pi TUI and does not install
// pi-tui into the desktop runtime, so this module keeps those imports inert.
// The context engine, historian and session-history injection do not use it.

export class Box {
  children = [];
  addChild(child) {
    this.children.push(child);
    return this;
  }
  addChildAt(child) {
    this.children.push(child);
    return this;
  }
  removeChild() {}
  clear() {
    this.children = [];
  }
  setPadding() {}
  setMargin() {}
  setBorder() {}
  setBackground() {}
}

export class Text {
  constructor(text = '') {
    this.text = String(text);
  }
  setText(text) {
    this.text = String(text);
    return this;
  }
  getText() {
    return this.text;
  }
  setColor() {}
}

export function matchesKey() {
  return false;
}

export function visibleWidth(value) {
  return String(value ?? '').length;
}

export function truncateToWidth(value, width) {
  const text = String(value ?? '');
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : text.length;
  return text.length <= limit ? text : text.slice(0, limit);
}
