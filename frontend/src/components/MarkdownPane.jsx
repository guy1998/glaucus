import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

const API_IMAGES = '/api/documents/images'

// Rewrite relative `images/` srcs at the string level so both raw-HTML <img>
// tags (rendered by rehypeRaw) and markdown image syntax get the correct URL.
function rewriteImageSrcs(md) {
  return md.replace(/src="images\//g, `src="${API_IMAGES}/`)
}

export default function MarkdownPane({ markdown, activeNodeId, scrollToNodeId, onNodeClick }) {
  const containerRef = useRef(null)
  const hoveredEls = useRef([])

  function getMarkdownBody() {
    return containerRef.current?.querySelector('.markdown-body') ?? null
  }

  function clearHover() {
    hoveredEls.current.forEach(el => el.classList.remove('node-hover'))
    hoveredEls.current = []
  }

  function handleMouseOver(e) {
    const body = getMarkdownBody()
    if (!body) return

    // Walk up to find the direct child of .markdown-body
    let el = e.target
    while (el && el.parentElement !== body) el = el.parentElement
    clearHover()
    if (!el || el === body) return

    // Find the anchor span that precedes this element (or is this element)
    let anchor = (el.tagName === 'SPAN' && el.id) ? el : null
    if (!anchor) {
      let sib = el.previousElementSibling
      while (sib) {
        if (sib.tagName === 'SPAN' && sib.id) { anchor = sib; break }
        sib = sib.previousElementSibling
      }
    }
    if (!anchor) return

    // Highlight every sibling between this anchor and the next anchor span
    let cur = anchor.nextElementSibling
    while (cur && !(cur.tagName === 'SPAN' && cur.id)) {
      cur.classList.add('node-hover')
      hoveredEls.current.push(cur)
      cur = cur.nextElementSibling
    }
  }

  useEffect(() => {
    if (!activeNodeId || !containerRef.current) return
    const prev = containerRef.current.querySelector('.node-active')
    if (prev) prev.classList.remove('node-active')

    const el = containerRef.current.querySelector(`[id="${CSS.escape(activeNodeId)}"]`)
    if (el) {
      el.classList.add('node-active')
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeNodeId])

  useEffect(() => {
    if (!scrollToNodeId || !containerRef.current) return
    const el = containerRef.current.querySelector(`[id="${CSS.escape(scrollToNodeId)}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [scrollToNodeId])

  function handleClick(e) {
    if (!onNodeClick) return
    // Node anchors are empty <span id="..."> siblings placed *before* content,
    // not ancestors — so we find the span whose top edge is nearest above the click.
    const anchors = [...containerRef.current.querySelectorAll('span[id]')]
    if (!anchors.length) return
    const clickY = e.clientY
    let best = null
    let bestDist = Infinity
    for (const a of anchors) {
      const dist = clickY - a.getBoundingClientRect().top
      if (dist >= 0 && dist < bestDist) { bestDist = dist; best = a }
    }
    if (best) onNodeClick(best.id)
  }

  const components = {
    img({ src, alt, ...props }) {
      return (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="max-w-full rounded-xl my-6 border border-zinc-200 shadow-sm"
          {...props}
        />
      )
    },
    table({ children, ...props }) {
      return (
        <div className="overflow-x-auto mb-4">
          <table className="min-w-full text-sm" {...props}>{children}</table>
        </div>
      )
    },
  }

  if (!markdown) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-300 text-sm">
        No content to display.
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto" onClick={handleClick} onMouseOver={handleMouseOver} onMouseLeave={clearHover}>
      <div className="max-w-3xl mx-auto px-10 py-10">
        <div className="markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={components}
          >
            {rewriteImageSrcs(markdown)}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
