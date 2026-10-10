/**
 * One parse5 pass over a recipe page, shared by `extractRecipeSource`
 * (what Gemini reads) and the import checks in `server/importChecks.ts`
 * (what the page holds). Nothing here calls Gemini or does I/O.
 *
 * Slices are cut from the original HTML by source location, never rebuilt
 * from parser text.
 */
import { parse, type DefaultTreeAdapterMap } from 'parse5';

type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlParent = DefaultTreeAdapterMap['parentNode'];
type HtmlChild = DefaultTreeAdapterMap['childNode'];

/** Original-HTML offsets of one element. */
export interface PageRegion {
  start: number;
  end: number;
}

/** An `<ol>` and how many `<li>` children it has. */
export interface PageList extends PageRegion {
  items: number;
}

/** A heading's offsets and its text. */
export interface PageHeading extends PageRegion {
  text: string;
}

export interface PageScan {
  html: string;
  /** Raw bodies of `application/ld+json` scripts, in source order. */
  scripts: string[];
  articles: PageRegion[];
  mains: PageRegion[];
  orderedLists: PageList[];
  headings: PageHeading[];
  /**
   * Text of elements whose `class` or `id` names instructions, directions,
   * a method, preparation, or steps. Recipe plugins mark their step lists
   * this way.
   */
  instructionBlocks: string[];
}

function isHtmlElement(node: HtmlChild): node is HtmlElement {
  return 'tagName' in node;
}

function attributeValue(element: HtmlElement, name: string): string | undefined {
  for (const attr of element.attrs) {
    if (attr.name === name) return attr.value;
  }
  return undefined;
}

/** `type` equals `application/ld+json` after trim, case-insensitively. Extra tokens do not count. */
function isLdJsonScript(element: HtmlElement): boolean {
  if (element.tagName !== 'script') return false;
  const type = attributeValue(element, 'type');
  return type !== undefined && type.trim().toLowerCase() === 'application/ld+json';
}

/** `role` equals `main` after trim, case-insensitively. `main-content` does not count. */
function isMainRole(element: HtmlElement): boolean {
  const role = attributeValue(element, 'role');
  return role !== undefined && role.trim().toLowerCase() === 'main';
}

/** Original-HTML span of an element. Implied nodes the parser invented have no location. */
function elementRegion(element: HtmlElement): PageRegion | null {
  const loc = element.sourceCodeLocation;
  if (!loc) return null;
  return { start: loc.startOffset, end: loc.endOffset };
}

/**
 * Raw script text, from the end of the start tag to the start of the end tag.
 * An unclosed `<script>` has no end tag and is not a JSON-LD candidate.
 */
function scriptRawText(html: string, element: HtmlElement): string | null {
  const loc = element.sourceCodeLocation;
  if (!loc?.startTag || !loc.endTag) return null;
  return html.slice(loc.startTag.endOffset, loc.endTag.startOffset);
}

/**
 * An HTML `<template>` keeps its children on `.content`. A `<template>` in
 * SVG or MathML is a foreign element with no content fragment; its children
 * are ordinary child nodes.
 */
function isHtmlTemplate(element: HtmlElement): element is DefaultTreeAdapterMap['template'] {
  return element.tagName === 'template' && 'content' in element;
}

/** Elements in source order, including HTML `<template>` contents. Comments are not elements. */
function walkElements(parent: HtmlParent, visit: (element: HtmlElement) => void): void {
  for (const child of parent.childNodes) {
    if (!isHtmlElement(child)) continue;
    visit(child);
    if (isHtmlTemplate(child)) walkElements(child.content, visit);
    walkElements(child, visit);
  }
}

/** Parser text of an element, skipping script and style bodies. */
function textContent(parent: HtmlParent): string {
  let text = '';
  for (const child of parent.childNodes) {
    if (child.nodeName === '#text') {
      text += (child as DefaultTreeAdapterMap['textNode']).value;
    } else if (isHtmlElement(child) && child.tagName !== 'script' && child.tagName !== 'style') {
      text += ` ${textContent(child)} `;
    }
  }
  return text;
}

function listItemCount(element: HtmlElement): number {
  return element.childNodes.filter((child) => isHtmlElement(child) && child.tagName === 'li')
    .length;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const INSTRUCTION_MARKER = /instruction|direction|method|preparation|steps?(?![a-z])/i;

function marksInstructions(element: HtmlElement): boolean {
  const marker = `${attributeValue(element, 'class') ?? ''} ${attributeValue(element, 'id') ?? ''}`;
  return INSTRUCTION_MARKER.test(marker);
}

export function scanPage(html: string): PageScan {
  const scan: PageScan = {
    html,
    scripts: [],
    articles: [],
    mains: [],
    orderedLists: [],
    headings: [],
    instructionBlocks: [],
  };
  walkElements(parse(html, { sourceCodeLocationInfo: true }), (element) => {
    if (isLdJsonScript(element)) {
      const body = scriptRawText(html, element);
      if (body !== null) scan.scripts.push(body);
      return;
    }
    const region = elementRegion(element);
    if (region === null) return;
    if (element.tagName === 'article') scan.articles.push(region);
    if (element.tagName === 'main' || isMainRole(element)) scan.mains.push(region);
    if (element.tagName === 'ol') scan.orderedLists.push({ ...region, items: listItemCount(element) });
    if (HEADING_TAGS.has(element.tagName)) {
      scan.headings.push({ ...region, text: textContent(element).replace(/\s+/g, ' ').trim() });
    }
    if (marksInstructions(element)) {
      const text = textContent(element).replace(/\s+/g, ' ').trim();
      if (text !== '') scan.instructionBlocks.push(text);
    }
  });
  return scan;
}

export function regionSource(html: string, region: PageRegion): string {
  return html.slice(region.start, region.end);
}

/** Script and style bodies still count; this is not `stripToText`. */
function regionTextLength(html: string, region: PageRegion): number {
  return regionSource(html, region).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

/** Equal lengths keep the earlier region (`len > bestLen`). */
function longestRegion(html: string, regions: PageRegion[]): PageRegion | null {
  let best: PageRegion | null = null;
  let bestLen = -1;
  for (const region of regions) {
    const len = regionTextLength(html, region);
    if (len > bestLen) {
      best = region;
      bestLen = len;
    }
  }
  return best;
}

/**
 * News-article recipes live in these regions, often after a long nav that
 * would eat the 60k text cap. The longest `<article>` wins, so a header
 * teaser or a nested related-story card does not replace the story.
 * A short article beside a larger `<main>` / `role="main"` yields to that
 * region. With neither, the whole page is the region.
 */
export function primaryRegion(scan: PageScan): PageRegion {
  const { html } = scan;
  const article = longestRegion(html, scan.articles);
  const main = longestRegion(html, scan.mains);
  if (article && main) {
    if (regionTextLength(html, article) * 2 >= regionTextLength(html, main)) return article;
    return main;
  }
  return article ?? main ?? { start: 0, end: html.length };
}

export function withinRegion(inner: PageRegion, outer: PageRegion): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * Tag strip for the text fallback, run on a slice of the original HTML, with
 * no length cap. A `>` inside a quoted attribute still ends `<[^>]+>` early,
 * so the rest of that attribute can leak into the text. End tags may carry
 * whitespace or junk before `>` (`</script >`), which browsers accept.
 */
export function stripToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
}

function collectedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectedText).join(' ');
  if (value && typeof value === 'object') {
    const row = value as { text?: unknown; name?: unknown };
    return `${collectedText(row.text)} ${collectedText(row.name)}`;
  }
  return '';
}

/**
 * A Recipe node that lists ingredients or steps but leaves them blank (Maangchi
 * publishes `recipeIngredient: []` and HowToSteps with only a position) is not
 * a recipe. A node that omits both fields is left alone: older fixtures and
 * partial blocks still go to Gemini as JSON-LD.
 */
function recipeJsonLdHasBody(node: object): boolean {
  const row = node as { recipeIngredient?: unknown; recipeInstructions?: unknown };
  const listsIngredients = Object.prototype.hasOwnProperty.call(node, 'recipeIngredient');
  const listsInstructions = Object.prototype.hasOwnProperty.call(node, 'recipeInstructions');
  if (!listsIngredients && !listsInstructions) return true;
  return (
    collectedText(row.recipeIngredient).trim() !== '' ||
    collectedText(row.recipeInstructions).trim() !== ''
  );
}

/**
 * The first schema.org Recipe node in the page's JSON-LD that has a body, or
 * `null`. `@graph` is unwrapped one level. Malformed blocks are skipped. A
 * Recipe that exists only inside a comment does not count, because a comment
 * is not an element.
 */
export function recipeJsonLdNode(scan: PageScan): Record<string, unknown> | null {
  for (const block of scan.scripts) {
    try {
      const parsed: unknown = JSON.parse(block);
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : ((parsed as { '@graph'?: unknown[] })['@graph'] ?? [parsed]);
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const type = (node as { '@type'?: string | string[] })['@type'];
        const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
        if (isRecipe && recipeJsonLdHasBody(node)) {
          return node as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed JSON-LD — keep looking.
    }
  }
  return null;
}
