// LLM streams routinely emit wrappers before the actual <bv-topic> block:
// a UTF-8 BOM (U+FEFF), a leading code-fence (```html / ``` ), or both.
// Peel those off before testing so the editorial viewer is reached.
const STRIP_PREFIX = /^\uFEFF?\s*(?:```(?:html|xml)?\s*\r?\n?)?\s*/i

export const isBvTopicHtml = (content: string): boolean => /^<bv-topic\b/i.test(content.replace(STRIP_PREFIX, ''))
