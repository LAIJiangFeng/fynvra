import { describe, expect, it } from 'vitest';
import {
  describeThinkingSource,
  isThinkingSource,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
  type ModelThinkingCapability,
  nextApprovalMode,
  parseChatImages,
  pickThinkingLevel,
  stripImageHints,
} from './chat';

// 档位集合取自 pi 1.4.0 内置目录（getSupportedThinkingLevels，含 max）
const haiku: ModelThinkingCapability = {
  thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultThinking: 'medium',
};
const opus: ModelThinkingCapability = {
  thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultThinking: 'medium',
};
const fable: ModelThinkingCapability = {
  thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultThinking: 'medium',
};
// gpt-5.5 的 max 映射为 null
const gpt55: ModelThinkingCapability = {
  thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
  defaultThinking: 'medium',
};
const gemini: ModelThinkingCapability = {
  thinkingLevels: ['low', 'medium', 'high'],
  defaultThinking: 'medium',
};
const noReasoning: ModelThinkingCapability = { thinkingLevels: [] };

describe('pickThinkingLevel', () => {
  it('keeps a requested level the model offers', () => {
    expect(pickThinkingLevel(haiku, 'off')).toBe('off');
    expect(pickThinkingLevel(opus, 'xhigh')).toBe('xhigh');
    expect(pickThinkingLevel(fable, 'max')).toBe('max');
    expect(pickThinkingLevel(opus, 'max')).toBe('max');
  });

  it("falls back to the model's default when the level is not in the new model's set", () => {
    // claude-haiku-5-5 可以关掉思考，切到 claude-opus-5-5（没有 off）回落到默认档位而不是就近
    expect(pickThinkingLevel(opus, 'off')).toBe('medium');
    expect(pickThinkingLevel(gemini, 'xhigh')).toBe('medium');
    // fable 开着 max 切到 gpt-5.5（没有 max）：回落到默认档位，不是就近的 xhigh
    expect(pickThinkingLevel(gpt55, 'max')).toBe('medium');
    expect(pickThinkingLevel(gemini, 'max')).toBe('medium');
    expect(pickThinkingLevel(fable, 'off')).toBe('medium');
  });

  it('uses the default when nothing was requested', () => {
    expect(pickThinkingLevel(opus)).toBe('medium');
  });

  it('has no level for a model without reasoning, whatever was requested', () => {
    expect(pickThinkingLevel(noReasoning, 'high')).toBeUndefined();
    expect(pickThinkingLevel(noReasoning, 'max')).toBeUndefined();
    expect(pickThinkingLevel(noReasoning)).toBeUndefined();
  });

  it('takes the middle offered level when the default is missing or not offered', () => {
    // 偶数个时取偏低的那一档
    expect(pickThinkingLevel({ thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })).toBe(
      'high'
    );
    expect(pickThinkingLevel({ thinkingLevels: ['low', 'medium', 'high', 'xhigh'] }, 'off')).toBe(
      'medium'
    );
    expect(pickThinkingLevel({ thinkingLevels: ['high', 'xhigh'] }, 'low')).toBe('high');
    expect(pickThinkingLevel({ thinkingLevels: ['max'] })).toBe('max');
    expect(
      pickThinkingLevel({ thinkingLevels: ['minimal', 'low'], defaultThinking: 'medium' }, 'off')
    ).toBe('minimal');
  });
});

describe('approval modes', () => {
  it('cycles supervised → auto-edits → full → supervised (Shift+Tab in the composer)', () => {
    expect(nextApprovalMode('supervised')).toBe('auto-edits');
    expect(nextApprovalMode('auto-edits')).toBe('full');
    expect(nextApprovalMode('full')).toBe('supervised');
  });
});

describe('thinking source', () => {
  it('accepts catalog, fallback and inferred:<catalog model id>', () => {
    for (const source of ['catalog', 'fallback', 'inferred:claude-opus-4-8', 'inferred:gpt-5.6']) {
      expect(isThinkingSource(source)).toBe(true);
    }
    for (const source of ['inferred:', 'inferred: gpt', 'Catalog', 'guess', '', 1, null, {}]) {
      expect(isThinkingSource(source)).toBe(false);
    }
  });

  it('marks inferred levels (with the catalog model they came from) and fallback levels', () => {
    expect(describeThinkingSource('inferred:gpt-5.6-sol')).toEqual({
      kind: 'inferred',
      model: 'gpt-5.6-sol',
    });
    expect(describeThinkingSource('fallback')).toEqual({ kind: 'fallback' });
    expect(describeThinkingSource('catalog')).toBeUndefined();
    expect(describeThinkingSource(undefined)).toBeUndefined();
  });
});

/** 解码后正好 `bytes` 字节的 base64（内容无关紧要，只看长度与末尾的 =） */
function base64Of(bytes: number): string {
  const groups = Math.ceil(bytes / 3);
  const padding = groups * 3 - bytes;
  return 'A'.repeat(groups * 4 - padding) + '='.repeat(padding);
}

const MiB = 1024 * 1024;
// 1×1 的透明 PNG
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('parseChatImages', () => {
  it('accepts 1 to 10 images in the allowed formats and returns copies with only data and mimeType', () => {
    const images = [
      { data: PIXEL, mimeType: 'image/png' },
      { data: '/9j/4AAQ', mimeType: 'image/jpeg' },
      { data: 'R0lGODlh', mimeType: 'image/gif' },
      { data: 'UklGRg==', mimeType: 'image/webp' },
    ];
    const parsed = parseChatImages(images);
    expect(parsed).toEqual(images);
    expect(parsed?.[0]).not.toBe(images[0]);
    expect(parseChatImages(Array.from({ length: MAX_CHAT_IMAGES }, () => images[0]))).toHaveLength(
      MAX_CHAT_IMAGES
    );
  });

  it('rejects anything but a list of 1 to 10 images', () => {
    const one = { data: PIXEL, mimeType: 'image/png' };
    for (const raw of [undefined, null, one, 'iVBORw0KGgo=', [], [one, null]]) {
      expect(parseChatImages(raw)).toBeNull();
    }
    expect(parseChatImages(Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => one))).toBeNull();
  });

  it('rejects formats outside the whitelist', () => {
    for (const mimeType of [
      'image/bmp',
      'image/svg+xml',
      'image/tiff',
      'IMAGE/PNG',
      'image/jpg',
      'text/plain',
      '',
      undefined,
      1,
    ]) {
      expect(parseChatImages([{ data: PIXEL, mimeType }])).toBeNull();
    }
  });

  it('rejects an image with keys other than data and mimeType', () => {
    expect(parseChatImages([{ data: PIXEL, mimeType: 'image/png', name: 'a.png' }])).toBeNull();
    expect(parseChatImages([{ data: PIXEL, mimeType: 'image/png', id: 'img-1' }])).toBeNull();
    expect(parseChatImages([{ data: PIXEL }])).toBeNull();
    expect(parseChatImages([{ mimeType: 'image/png' }])).toBeNull();
  });

  it('rejects data that is not plain base64', () => {
    for (const data of [
      '',
      'QUJ',
      'QUJD!',
      'QU JD',
      'QUJD\nQUJD',
      'QU=D',
      'Q===',
      '-_-_',
      `data:image/png;base64,${PIXEL}`,
      42,
      null,
    ]) {
      expect(parseChatImages([{ data, mimeType: 'image/png' }])).toBeNull();
    }
  });

  it('measures the decoded size from the string length: 20 MiB per image, 50 MiB in total', () => {
    const image = (bytes: number) => ({ data: base64Of(bytes), mimeType: 'image/png' });
    expect(MAX_CHAT_IMAGE_BYTES).toBe(20 * MiB);
    expect(MAX_CHAT_IMAGES_TOTAL_BYTES).toBe(50 * MiB);
    for (const bytes of [1, 2, 3, MAX_CHAT_IMAGE_BYTES]) {
      expect(parseChatImages([image(bytes)])).not.toBeNull();
    }
    expect(parseChatImages([image(MAX_CHAT_IMAGE_BYTES + 1)])).toBeNull();
    expect(parseChatImages([image(20 * MiB), image(20 * MiB), image(10 * MiB)])).toHaveLength(3);
    expect(parseChatImages([image(20 * MiB), image(20 * MiB), image(10 * MiB + 1)])).toBeNull();
    expect(parseChatImages([image(17 * MiB), image(17 * MiB), image(17 * MiB)])).toBeNull();
  });
});

describe('stripImageHints', () => {
  const resized =
    '[Image: original 3773x1017, displayed at 2000x539. Multiply coordinates by 1.89 to map to original image.]';
  const converted = '[Image converted from image/webp to image/png.]';
  const omitted = '[Image omitted: could not be resized below the inline image size limit.]';

  it('removes the hint lines pi appends after the text, with the blank line before them', () => {
    expect(stripImageHints(`What is wrong here?\n\n${resized}`)).toBe('What is wrong here?');
    expect(stripImageHints(`Compare them\n\n${converted}\n${resized}\n${omitted}`)).toBe(
      'Compare them'
    );
    expect(stripImageHints(`first\n\nsecond paragraph\n\n${omitted}`)).toBe(
      'first\n\nsecond paragraph'
    );
  });

  it('leaves an empty string when the text was only the hint lines', () => {
    expect(stripImageHints(`\n\n${resized}`)).toBe('');
    expect(stripImageHints(`\n\n${converted}\n${resized}`)).toBe('');
    expect(stripImageHints(omitted)).toBe('');
  });

  it('leaves text without hint lines alone', () => {
    for (const text of ['', 'hello', 'a\n\nb', 'ends with a blank line\n\n']) {
      expect(stripImageHints(text)).toBe(text);
    }
  });

  it('keeps text that only looks like a hint when it is not the block at the end', () => {
    for (const text of [
      `${resized}\n\nWhat do the coordinates mean?`,
      'See [Image: chart] below',
      `no blank line before\n${resized}`,
      `middle\n\n${resized}\n\nend`,
      `trailing words\n\n${resized} right?`,
      'brackets\n\n[Imagery is fine]',
    ]) {
      expect(stripImageHints(text)).toBe(text);
    }
  });
});
