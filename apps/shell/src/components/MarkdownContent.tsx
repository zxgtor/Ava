import { memo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

interface Props {
  content: string
}

function getPlainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getPlainText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    const children = (node as { props?: { children?: ReactNode } }).props?.children
    if (children !== undefined) return getPlainText(children)
  }
  return ''
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const language = className?.replace(/^language-/, '') || 'text'
  const text = getPlainText(children).replace(/\n$/, '')

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* noop */ }
  }

  return (
    <div className="relative group/code my-2 bg-[#0d1117] rounded-lg overflow-hidden border border-border-subtle max-w-full">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs text-text-3 bg-surface-2/40 border-b border-border-subtle">
        <span className="font-mono">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer hover:bg-surface-3 hover:text-text-2 transition-colors"
          title={copied ? '已复制' : '复制'}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="px-4 py-3 text-[13px] leading-relaxed overflow-x-auto hide-scrollbar">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

const COMPONENTS: Components = {
  // block-level code (fenced) vs inline code
  code: ({ className, children, ...rest }) => {
    const isInline = !className
    if (isInline) {
      return (
        <code
          {...rest}
          className="px-1.5 py-0.5 text-[0.9em] bg-surface-2 text-accent rounded border border-border-subtle break-all"
        >
          {children}
        </code>
      )
    }
    return <CodeBlock className={className}>{children}</CodeBlock>
  },
  // react-markdown wraps fenced code in <pre><code>, but CodeBlock already renders <pre>.
  // So we strip the outer <pre> from default rendering.
  pre: ({ children }) => <>{children}</>,

  a: ({ children, href, ...rest }) => (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent transition-colors"
    >
      {children}
    </a>
  ),

  ul: ({ children }) => <ul className="list-disc list-outside pl-6 my-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-outside pl-6 my-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,

  h1: ({ children }) => <h1 className="text-lg font-semibold mt-4 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold mt-4 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mt-3 mb-1.5 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-medium mt-3 mb-1 first:mt-0">{children}</h4>,

  blockquote: ({ children }) => (
    <blockquote className="my-2 pl-3 border-l-2 border-border text-text-2 italic">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-3 border-t border-border-subtle" />,

  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1 text-left font-medium border border-border-subtle">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1 border border-border-subtle">{children}</td>,

  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
}

function MarkdownContentImpl({ content }: Props) {
  return (
    <div className="markdown-body w-fit">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const MarkdownContent = memo(MarkdownContentImpl)
