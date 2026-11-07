import { type EditorView, WidgetType } from '@uiw/react-codemirror';
import type { MarkdownReferences } from '@/lib/markdownPreview';

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dom = document.createElement('span');
    dom.className = 'cm-ml-bullet';
    dom.textContent = '•';
    return dom;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dom = document.createElement('span');
    dom.className = 'cm-ml-hr';
    return dom;
  }
}

/** 任务复选框：点击即一次普通的、可撤销的源码编辑（[ ] ↔ [x]），不移动光标。 */
export class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.tabIndex = -1;
    box.className = 'cm-ml-task';
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('click', (event) => {
      // 勾选状态以源码为准，由编辑后的重绘决定。
      event.preventDefault();
      const pos = view.posAtDOM(box);
      const marker = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
        userEvent: 'input',
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const destroyed = new WeakSet<HTMLElement>();

/** 图片只经 references.readImage 加载（与 LocalImage 相同的规则），失败时显示 alt。 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly title: string | undefined,
    readonly references: MarkdownReferences
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.references === this.references
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('span');
    dom.className = 'cm-ml-image';
    if (this.title) dom.title = this.title;
    const fallback = () => {
      const text = document.createElement('span');
      text.className = 'cm-ml-image-alt';
      text.textContent = this.alt;
      dom.replaceChildren(text);
    };
    fallback();
    void this.references.readImage(this.src).then((dataUrl) => {
      if (!dataUrl || destroyed.has(dom)) return;
      const img = document.createElement('img');
      img.alt = this.alt;
      img.src = dataUrl;
      img.addEventListener('load', () => view.requestMeasure());
      img.addEventListener('error', () => {
        fallback();
        view.requestMeasure();
      });
      dom.replaceChildren(img);
    });
    return dom;
  }
  destroy(dom: HTMLElement) {
    destroyed.add(dom);
  }
  ignoreEvent() {
    return false;
  }
}
