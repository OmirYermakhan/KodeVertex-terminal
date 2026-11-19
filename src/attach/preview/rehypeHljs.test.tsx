import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { rehypeDiff } from '../../claude/diffBlock'
import { rehypeHljs } from './highlight'

const html = (md: string, plugin: typeof rehypeHljs | typeof rehypeHighlight) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeDiff, plugin]}>
      {md}
    </ReactMarkdown>,
  )

const SAMPLES = [
  '```ts\nconst x: number = 1\nfunction f(a: string) { return a.length }\n```',
  '```tsx\nexport const A = () => <div className="a">{1}</div>\n```',
  '```json\n{"a": [1, true, null]}\n```',
  '```bash\nfor f in *.ts; do echo "$f"; done\n```',
  '```sh\nls -la | grep x\n```',
  '```rust\nfn main() { let v: Vec<u8> = vec![]; println!("{}", v.len()); }\n```',
  '```python\ndef f(x):\n    return [i for i in range(x)]\n```',
  '```go\nfunc main() { fmt.Println("hi") }\n```',
  '```css\n.a > b { color: red; }\n```',
  '```html\n<div id="x"><b>t</b></div>\n```',
  '```yaml\na: 1\nb: [x, y]\n```',
  '```sql\nSELECT * FROM t WHERE id = 1;\n```',
  '```swift\nlet x = [1, 2].map { $0 * 2 }\n```',
  '```kotlin\nfun main() = println("x")\n```',
  '```diff\n-a\n+b\n```',
  '```unknownlang\nraw <text>\n```',
  '```\nno language at all\n```',
  'Текст с `кодом` и\n\n```js\nconsole.log(1)\n```\n\nи после.',
]

describe('rehypeHljs', () => {
  it.each(SAMPLES)('та же разметка, что у rehype-highlight: %s', (md) => {
    expect(html(md, rehypeHljs)).toBe(html(md, rehypeHighlight))
  })

  it('подсвечивает код классами hljs-*', () => {
    expect(html('```ts\nconst x = 1\n```', rehypeHljs)).toContain('hljs-keyword')
  })
})
