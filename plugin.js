/**
 * quote-comment — right-click a text selection inside an assistant message:
 * Copy it, or queue a quote+comment that is appended to the next outgoing
 * message (composer middleware). Statusbar chip `💬 N` opens the queue.
 *
 * Why it looks the way it does:
 * - The file is loaded uncompiled ESM and hot-reloaded on every save, so all
 *   UI is built with jsx()/jsxs() and module-scope listeners are re-wired via
 *   the globalThis remove-then-add trick (a naive addEventListener would
 *   stack dead closures from previous reloads).
 * - Floating UI (menu / dialog / popover) renders from the statusbar
 *   contribution — the one contribution area that is always mounted and not
 *   closable — as position:fixed nodes, escaping the bar layout.
 * - intercepting contextmenu with preventDefault also suppresses the app's
 *   own menu, so Copy must be re-implemented via ctx.os.writeClipboard.
 */

import { COMPOSER_AREAS, STATUSBAR_AREAS, atom, useValue, Button, Textarea, Tip } from '@hermes/plugin-sdk'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

// -- state ---------------------------------------------------------------

/** Open context menu: screen position + the selected text it was opened on. */
const menuAtom = atom({ open: false, x: 0, y: 0, text: '' })
/** Comment dialog: opened with the quoted text. */
const dialogAtom = atom({ open: false, quote: '' })
/** Queued quote+comment items, drained by the composer middleware. */
const pendingAtom = atom([])
/** Queue popover (chip click). */
const listOpenAtom = atom(false)

// ctx is only reachable inside register(); store it for use in component
// handlers (os.writeClipboard). Re-assigned on every reload.
let ctxRef = null

// When a menu row activates on pointerdown, the menu unmounts inside that
// handler; Chromium then re-hit-tests for the gesture's compat mousedown and
// lands on whatever sits UNDER the (now removed) menu — an unrelated element.
// That mousedown would run closeAll and instantly kill the dialog the row
// just opened. Consume the first mousedown after a row activation instead.
let suppressDismiss = false
let suppressResetTimer = 0

function armDismissSuppression() {
  suppressDismiss = true
  clearTimeout(suppressResetTimer)
  suppressResetTimer = setTimeout(() => {
    suppressDismiss = false
  }, 1500)
}

// -- composer insertion ---------------------------------------------------

/** Block formatting shared by the visible insert and the middleware.
 *  Quotes are prefixed per PARAGRAPH (blank-line-separated block), not per
 *  line, so a selection containing mid-sentence line breaks stays one
 *  blockquote instead of being broken into "> " fragments. */
function formatCommentBlock(quote, comment) {
  const quoted = quote
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `> ${paragraph}`)
    .join('\n\n')

  return comment ? `${quoted}\n\n${comment}` : quoted
}

/** A comment block that was inserted VISIBLY into the composer. The composer
 *  editor syncs its draft from real input events, so an execCommand insert
 *  sticks; the middleware keeps this copy only as a fallback in case the
 *  draft never took it. */
let visibleBlockText = null
let visibleSnippet = null

function pickComposer() {
  const active = document.activeElement

  if (active instanceof Element) {
    const slot = '[data-slot="composer-rich-input"]'

    if (active.matches(slot)) {
      return active
    }

    if (active.closest(slot)) {
      return active.closest(slot)
    }
  }

  const visible = [...document.querySelectorAll('[data-slot="composer-rich-input"]')].find(
    el => el.getClientRects().length > 0
  )

  return visible || document.querySelector('[data-slot="composer-rich-input"]')
}

/** Insert text at the end of the (focused or visible) composer. Returns true
 *  only when the text verifiably landed in the editor DOM. */
function insertIntoComposer(text) {
  try {
    const el = pickComposer()

    if (!el) {
      return false
    }

    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    // A blank line before the block when the composer already has text, so
    // the blockquote starts its own paragraph (matches the middleware).
    const isEmpty = el.textContent.trim() === ''
    const ok = document.execCommand('insertText', false, isEmpty ? text : `\n\n${text}`)
    const firstLine = text.split('\n').find(line => line.trim()) || ''

    return Boolean(ok) && el.textContent.includes(firstLine.slice(0, 24))
  } catch {
    return false
  }
}

// -- app-menu flash suppression -------------------------------------------

/** Roots temporarily stamped with the app's own context-menu opt-out
 *  attribute (`data-hermes-context-menu-trigger`) during a right-click
 *  gesture, so the app's window-capture handler skips them and never opens
 *  its menu — no flash, no double menu. Cleared the moment the gesture's
 *  contextmenu event has been decided (or on mouseup / unload). */
const markedRoots = new Set()
let markClearTimer = 0

function markRoot(root) {
  if (root && !markedRoots.has(root)) {
    root.setAttribute('data-hermes-context-menu-trigger', '')
    markedRoots.add(root)
  }

  // Safety net for gestures that never produce a contextmenu event. NOTE:
  // must NOT be cleared on mouseup — on Windows the contextmenu event fires
  // AFTER mouseup, so clearing there would strip the attribute before the
  // app's handler (which runs first on window capture) ever sees it.
  clearTimeout(markClearTimer)
  markClearTimer = setTimeout(clearMarks, 600)
}

function clearMarks() {
  clearTimeout(markClearTimer)

  for (const root of markedRoots) {
    root.removeAttribute('data-hermes-context-menu-trigger')
  }

  markedRoots.clear()
}

function selectionContext() {
  const selection = window.getSelection()
  const text = selection ? selection.toString().trim() : ''

  return text ? { selection, text } : null
}

function messageRootOf(node) {
  const el = node instanceof Element ? node : node?.parentElement

  return el?.closest?.('[data-role="user"], [data-role="assistant"]') ?? null
}

// -- theme helpers -------------------------------------------------------

const SURFACE = {
  position: 'fixed',
  zIndex: 'var(--z-over-modal)',
  background: 'var(--ui-bg-elevated)',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  color: 'var(--ui-text-primary)',
  fontSize: 13,
  fontFamily: 'inherit'
}

// -- floating surfaces (single component tree under the statusbar chip) ---

function PluginRoot() {
  const menu = useValue(menuAtom)
  const dialog = useValue(dialogAtom)
  const pending = useValue(pendingAtom)
  const listOpen = useValue(listOpenAtom)
  const n = pending.length

  return jsxs(Fragment, {
    children: [
      // Chip only when something is queued; overlays render even when the
      // queue is empty (a menu can open before the first comment is added).
      n > 0 &&
        jsx(Tip, {
          key: 'chip',
          label: `${n} comment${n === 1 ? '' : 's'} will be appended to your next message`,
          children: jsx('button', {
            'data-qc': 'chip',
            type: 'button',
            onClick: () => listOpenAtom.set(!listOpenAtom.get()),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              height: '100%',
              padding: '0 8px',
              border: 0,
              background: 'transparent',
              color: 'var(--ui-text-secondary)',
              fontSize: 12,
              fontFamily: 'inherit',
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            },
            children: `💬 ${n}`
          })
        }),
      menu.open && jsx(ContextMenuCard, { key: 'menu', x: menu.x, y: menu.y, text: menu.text }),
      dialog.open && jsx(CommentDialog, { key: 'dialog', quote: dialog.quote }),
      listOpen && n > 0 && jsx(QueueCard, { key: 'queue', items: pending })
    ]
  })
}

function closeMenu() {
  menuAtom.set({ open: false, x: 0, y: 0, text: '' })
}

function closeDialog() {
  dialogAtom.set({ open: false, quote: '' })
}

function closeAll() {
  closeMenu()
  closeDialog()
  listOpenAtom.set(false)
}

/** The app's Radix context menu dismisses on an OUTSIDE pointerdown (and
 *  preventDefaults that pointerdown, which is what would kill clicks on our
 *  rows — see MenuRow). Dispatching a synthetic pointerdown on body the frame
 *  after we open closes the app's menu so only ours remains; the event fires
 *  no compat mousedown, so our own dismiss handlers ignore it. Dispatched
 *  again after 120ms because the app menu mounts asynchronously (race). */
function dismissAppMenu() {
  const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })

  document.body.dispatchEvent(ev)
}

/** One row of the context menu. Activates on POINTERDOWN, not click: while
 *  the app's own Radix menu is still open, its DismissableLayer
 *  preventDefaults outside pointerdowns — Chromium then suppresses the whole
 *  mousedown/mouseup/click sequence on our rows. React's onPointerDown fires
 *  before Radix's document-level handler, so acting there always wins.
 *  Hover state lives in React (no class list available at runtime — the app's
 *  Tailwind build never scans this file). */
function MenuRow({ label, onSelect }) {
  const [hover, setHover] = useState(false)

  return jsx('button', {
    type: 'button',
    onPointerDown: onSelect,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'block',
      width: '100%',
      padding: '5px 10px',
      border: 0,
      borderRadius: 4,
      textAlign: 'left',
      background: hover ? 'var(--ui-control-hover-background)' : 'transparent',
      color: 'var(--ui-text-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
      cursor: 'pointer'
    },
    children: label
  })
}

function ContextMenuCard({ x, y, text }) {
  const left = Math.min(x, window.innerWidth - 176)
  const top = Math.min(y, window.innerHeight - 100)

  return jsxs('div', {
    'data-qc': 'menu',
    style: { ...SURFACE, left, top, minWidth: 160, padding: 4 },
    children: [
      jsx(MenuRow, {
        label: 'Copy',
        onSelect: () => {
          armDismissSuppression()
          void ctxRef.os.writeClipboard(text)
          closeMenu()
        }
      }),
      jsx(MenuRow, {
        label: 'Comment',
        onSelect: () => {
          armDismissSuppression()
          dialogAtom.set({ open: true, quote: text })
          closeMenu()
        }
      })
    ]
  })
}

function CommentDialog({ quote }) {
  const [comment, setComment] = useState('')
  const truncated = quote.length > 200 ? `${quote.slice(0, 200)}…` : quote

  const submit = () => {
    const trimmed = comment.trim()
    const block = formatCommentBlock(quote, trimmed)

    // Prefer a VISIBLE insert into the composer (fires a real input event,
    // so the app's draft syncs). Only when that is impossible do we queue
    // for the middleware to append at send time.
    if (insertIntoComposer(block)) {
      visibleBlockText = block
      visibleSnippet = trimmed || quote.slice(0, 40)
    } else {
      pendingAtom.set([...pendingAtom.get(), { quote, comment: trimmed }])
    }

    // Selection is cleared so the quoted text no longer floats over the chat.
    window.getSelection()?.removeAllRanges()
    closeDialog()
  }

  return jsxs('div', {
    'data-qc': 'dialog',
    style: {
      ...SURFACE,
      left: '50%',
      top: '45%',
      transform: 'translate(-50%, -50%)',
      width: 'min(440px, calc(100vw - 32px))',
      padding: 14
    },
    children: [
      jsx('div', {
        title: quote,
        style: {
          maxHeight: 120,
          overflow: 'auto',
          padding: 8,
          marginBottom: 10,
          border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: 4,
          background: 'var(--ui-bg-tertiary)',
          color: 'var(--ui-text-secondary)',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        },
        children: truncated
      }),
      jsx(Textarea, {
        // Focus on mount via callback ref (beats autoFocus, which loses the
        // race against the gesture's compat mousedown focus-steal — that is
        // separately prevented in onMouseDown).
        ref: el => {
          el?.focus()
        },
        value: comment,
        onChange: e => setComment(e.target.value),
        placeholder: 'Add a comment…',
        style: { width: '100%', minHeight: 72, resize: 'vertical', fontSize: 13 },
        onKeyDown: e => {
          // Enter (no Shift) submits; Escape cancels (handled globally so a
          // reloaded plugin can't double-handle it).
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }
      }),
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
        children: [
          jsx(Button, { type: 'button', variant: 'secondary', onClick: closeDialog, children: 'Cancel' }),
          jsx(Button, { type: 'button', variant: 'default', onClick: submit, children: 'Submit' })
        ]
      })
    ]
  })
}

function QueueCard({ items }) {
  const remove = index => pendingAtom.set(items.filter((_, i) => i !== index))

  const row = (item, index) =>
    jsxs('div', {
      key: index,
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 8px'
      },
      children: [
        jsxs('div', {
          style: { flex: 1, minWidth: 0 },
          children: [
            jsx('div', {
              style: {
                color: 'var(--ui-text-tertiary)',
                fontSize: 12,
                lineHeight: 1.4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              },
              children: item.quote
            }),
            item.comment &&
              jsx('div', {
                style: {
                  color: 'var(--ui-text-secondary)',
                  fontSize: 12,
                  lineHeight: 1.4,
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: item.comment
              })
          ]
        }),
        jsx('button', {
          type: 'button',
          title: 'Remove',
          onClick: () => remove(index),
          style: {
            flexShrink: 0,
            padding: '0 4px',
            border: 0,
            background: 'transparent',
            color: 'var(--ui-text-tertiary)',
            fontSize: 11,
            fontFamily: 'inherit',
            cursor: 'pointer'
          },
          children: '✕'
        })
      ]
    })

  return jsxs('div', {
    'data-qc': 'popover',
    style: { ...SURFACE, right: 8, bottom: 30, width: 280, maxHeight: 300, overflowY: 'auto', padding: 6 },
    children: [
      jsx('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 8px',
          color: 'var(--ui-text-tertiary)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.04
        },
        children: `Queued (${items.length})`
      }),
      ...items.map((item, index) => row(item, index)),
      jsx('button', {
        type: 'button',
        onClick: () => {
          pendingAtom.set([])
          listOpenAtom.set(false)
        },
        style: {
          display: 'block',
          width: '100%',
          marginTop: 4,
          padding: '6px 8px',
          borderTop: '1px solid var(--ui-stroke-secondary)',
          background: 'transparent',
          color: 'var(--ui-text-secondary)',
          fontSize: 12,
          fontFamily: 'inherit',
          textAlign: 'center',
          cursor: 'pointer'
        },
        children: 'Clear all'
      })
    ]
  })
}

// -- composer middleware --------------------------------------------------

function middlewareHandler(draft) {
  const pending = pendingAtom.get()
  let block = null
  let snippet = null

  if (pending.length > 0) {
    block = pending.map(({ quote, comment }) => formatCommentBlock(quote, comment)).join('\n\n')
    snippet = pending[0].comment.trim() || pending[0].quote.slice(0, 40)
    pendingAtom.set([])
  } else if (visibleBlockText) {
    // Visible insert fallback: the block was inserted into the composer; if
    // the draft never took it (editor reverted), deliver it now.
    block = visibleBlockText
    snippet = visibleSnippet
    visibleBlockText = null
    visibleSnippet = null
  }

  if (!block) {
    return draft
  }

  // Already visible in the draft (the composer insert stuck) — nothing to add.
  if (snippet && draft.text.includes(snippet)) {
    return draft
  }

  // Exactly one blank line between the draft and the block; no leading
  // whitespace on an empty draft.
  const base = draft.text ? draft.text.trimEnd() : ''
  const text = base ? `${base}\n\n${block}` : block

  return { ...draft, text }
}

// -- contextmenu interception + dismissal listeners -----------------------

// Keys for the hot-reload listener swap: a re-evaluated plugin removes the
// previous incarnation's listener before adding its own, so listeners never
// stack and never point at dead closures.
const KEY_CONTEXTMENU = '__qc_ctxmenu_handler'
const KEY_MOUSEDOWN = '__qc_mousedown_handler'
const KEY_KEYDOWN = '__qc_keydown_handler'
const KEY_SCROLL = '__qc_scroll_handler'
const KEY_BLUR = '__qc_blur_handler'
const KEY_RESIZE = '__qc_resize_handler'

function bindOnce(key, target, type, fn, capture) {
  const previous = globalThis[key]

  if (previous) {
    target.removeEventListener(type, previous, capture)
  }

  target.addEventListener(type, fn, capture)
  globalThis[key] = fn
}

function unbind(key, target, type, capture) {
  const fn = globalThis[key]

  if (fn) {
    target.removeEventListener(type, fn, capture)
    delete globalThis[key]
  }
}

export default {
  id: 'quote-comment',
  name: 'Quote & Comment',
  register(ctx) {
    ctxRef = ctx

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 130,
      render: () => jsx(PluginRoot, {})
    })

    ctx.register({
      id: 'middleware',
      area: COMPOSER_AREAS.middleware,
      data: { handler: middlewareHandler }
    })

    // NOTE: listeners attach to WINDOW (capture), not document. The app's own
    // context-menu system (AppContextMenu) listens on window capture and calls
    // stopPropagation() on every right-click — which kills all DOCUMENT-level
    // listeners before they ever run. stopPropagation does NOT stop other
    // listeners on the SAME target (that's stopImmediatePropagation), so a
    // window-capture listener still fires after the app's. The app's DOM menu
    // (a Radix DropdownMenu) also opens for message-text selections; ours
    // layers on top at --z-over-modal, and the Radix menu closes on the
    // outside pointerdown when a row of ours is clicked.
    const onContextMenu = event => {
      // The app's handler has ALREADY made its decision (it registered
      // before us on the same target) — remove the gesture's temporary
      // trigger-attribute stamps now, whatever we decide below.
      clearMarks()

      const ctxInfo = selectionContext()

      // Empty selection or a right-click outside message text: stand down
      // entirely (also clears any stale menu of ours) and let the app's menu
      // handle the gesture.
      if (!ctxInfo || !messageRootOf(event.target) || !messageRootOf(ctxInfo.selection.anchorNode)) {
        closeAll()

        return
      }

      // Suppressing the app menu means WE must offer Copy ourselves.
      event.preventDefault()
      event.stopPropagation()
      menuAtom.set({ open: true, x: event.clientX, y: event.clientY, text: ctxInfo.text })
      requestAnimationFrame(dismissAppMenu)
      setTimeout(dismissAppMenu, 120)
    }

    // Anything interacting with a floating surface (or the chip itself) is
    // ignored; every other mousedown closes all of them. Detached targets are
    // ignored too: unmounting the menu inside a pointerdown handler detaches
    // the row, so the compat mousedown that follows targets a dead node whose
    // closest('[data-qc]') is null — treating it as "outside" would
    // instantly close the dialog that handler just opened.
    const onMouseDown = event => {
      if (suppressDismiss) {
        suppressDismiss = false
        // This is the gesture's own compat mousedown (see armDismissSuppression).
        // Block its DEFAULT action too: without this, the browser moves focus
        // to the element re-hit-tested under the cursor and steals it from
        // the dialog textarea that just mounted.
        event.preventDefault()

        return
      }

      // Right-button press with a message selection: stamp the message roots
      // with the app's context-menu opt-out attribute BEFORE the contextmenu
      // event fires, so the app's own handler skips them entirely (no menu,
      // no flash). Marks are cleared in onContextMenu / onMouseUp.
      if (event.button === 2) {
        const info = selectionContext()

        if (info && messageRootOf(event.target) && messageRootOf(info.selection.anchorNode)) {
          markRoot(messageRootOf(event.target))
          markRoot(messageRootOf(info.selection.anchorNode))
        }
      }

      const target = event.target instanceof Element ? event.target : null

      if (!target || !target.isConnected || target.closest('[data-qc]')) {
        return
      }

      closeAll()
    }

    // Safety net removed: onMouseUp must NOT clear the marks — on Windows the
    // contextmenu event fires after mouseup; the 600ms timer in markRoot
    // covers gestures that never produce a contextmenu event.

    const onKeyDown = event => {
      if (event.key !== 'Escape') {
        return
      }

      if (dialogAtom.get().open) {
        closeDialog()
      } else {
        closeAll()
      }
    }

    // Scroll/resize/blur close floating surfaces (menu must not follow the
    // page away). Scrolls INSIDE a surface (textarea, list) are fine — the
    // capture-phase target identifies the scroller.
    const onScroll = event => {
      if (event.target instanceof Element && event.target.closest('[data-qc]')) {
        return
      }

      closeAll()
    }

    bindOnce(KEY_CONTEXTMENU, window, 'contextmenu', onContextMenu, true)
    bindOnce(KEY_MOUSEDOWN, window, 'mousedown', onMouseDown, true)
    bindOnce(KEY_KEYDOWN, window, 'keydown', onKeyDown, true)
    bindOnce(KEY_SCROLL, window, 'scroll', onScroll, true)
    bindOnce(KEY_BLUR, window, 'blur', closeAll, false)
    bindOnce(KEY_RESIZE, window, 'resize', closeAll, false)

    // Full unload (disable/remove) must give the app its native menu back.
    ctx.onDispose(() => {
      clearMarks()
      unbind(KEY_CONTEXTMENU, window, 'contextmenu', true)
      unbind(KEY_MOUSEDOWN, window, 'mousedown', true)
      unbind(KEY_KEYDOWN, window, 'keydown', true)
      unbind(KEY_SCROLL, window, 'scroll', true)
      unbind(KEY_BLUR, window, 'blur', false)
      unbind(KEY_RESIZE, window, 'resize', false)
    })
  }
}
