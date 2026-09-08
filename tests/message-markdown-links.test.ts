import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { firstHttpUrlInMarkdown } from '../src/lib/markdownUrls'
import { remarkCumora } from '../src/lib/remarkCumora'

async function parse(markdown: string): Promise<Root> {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCumora)
  return await processor.run(processor.parse(markdown)) as Root
}

describe('chat Markdown links', () => {
  it('repairs a bold URL followed immediately by CJK prose', async () => {
    const tree = await parse('浏览器打开 **http://127.0.0.1:4182**（本机 preview）')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return

    assert.deepEqual(paragraph.children.map((node) => node.type), ['text', 'strong', 'text', 'text'])
    const strong = paragraph.children[1]
    assert.equal(strong.type, 'strong')
    if (strong.type !== 'strong') return
    const link = strong.children[0]
    assert.equal(link.type, 'link')
    if (link.type !== 'link') return
    assert.equal(link.url, 'http://127.0.0.1:4182')
    assert.equal(link.children[0].type === 'text' ? link.children[0].value : null, link.url)
    const visibleText = paragraph.children
      .filter((node) => node.type === 'text')
      .map((node) => node.value)
      .join('')
    assert.equal(visibleText, '浏览器打开 （本机 preview）')
    assert.ok(!visibleText.includes('**'))
  })

  it('keeps a literal URL as one non-nested link', async () => {
    const tree = await parse('打开 https://example.com/path')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return
    const link = paragraph.children.find((node) => node.type === 'link')
    assert.ok(link && link.type === 'link')
    assert.deepEqual(link.children.map((node) => node.type), ['text'])
  })

  it('stops a literal URL at CJK punctuation', async () => {
    const tree = await parse('详见 https://example.com/path（说明）')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return
    const link = paragraph.children.find((node) => node.type === 'link')
    assert.ok(link && link.type === 'link')
    assert.equal(link.url, 'https://example.com/path')
  })

  it('does not alter an explicit Markdown link', async () => {
    const tree = await parse('[本机预览](http://127.0.0.1:4182)')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return
    const link = paragraph.children[0]
    assert.equal(link.type, 'link')
    if (link.type !== 'link') return
    assert.equal(link.url, 'http://127.0.0.1:4182')
    assert.equal(link.children[0].type === 'text' ? link.children[0].value : null, '本机预览')
  })

  it('uses the same URL boundary for link previews', () => {
    assert.equal(
      firstHttpUrlInMarkdown('浏览器打开 **http://127.0.0.1:4182**（本机 preview）'),
      'http://127.0.0.1:4182',
    )
    assert.equal(
      firstHttpUrlInMarkdown('详见 https://example.com/path（说明）'),
      'https://example.com/path',
    )
  })
})
