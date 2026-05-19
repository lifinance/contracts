# Notion MCP edit hygiene

Mechanics for editing Notion pages via the MCP without losing data or generating duplicates. Load this when working with Notion pages; the SKILL.md body assumes you've read it.

## Always re-fetch before non-trivial edits

The Notion pages used by the catalogue are shared workspace artifacts. Humans and other AI sessions may edit them in parallel with your work. State you saw at the start of a session may have changed mid-session.

**Mandatory discipline:**

1. **Always `notion-fetch` the affected page immediately before any non-trivial edit.** Stale context older than ~5 minutes is risky on a shared doc.
2. **For large batched edits**: fetch → construct `old_str` values from the just-fetched content → submit immediately. Don't interleave other tool calls between construction and submission.
3. **After every edit, fetch again to verify.** Don't trust the `{page_id: ...}` response as confirmation.

### Concrete failure modes if you skip the re-fetch

- **Page edited mid-session**: your `old_str` no longer matches because someone reworded a paragraph. Edit fails with "No matches found" — or worse, fuzzy-matches the wrong block.
- **New blocks added**: new Qs appear that you don't know about; your sync check from a stale fetch flags them as orphans incorrectly.
- **Stories split or restructured**: e.g. I22 → I22a + I22b. Your `old_str` for the original I22 won't match anything.
- **Marker chains grow**: a story that had `❓Q4.8` now has `❓Q4.8, Q4.10`. Your update replacing `❓Q4.8` no longer matches.

## The timeout-is-deceptive pattern

`notionhq_client_request_timeout` from `notion-update-page` does **NOT** mean the edit failed. Observed in practice: the request reaches the server, the server processes it (sometimes partially), the response doesn't arrive in time. The page IS modified.

**Always verify with a fetch after a timeout, never blindly retry.** A blind retry can:

- Succeed twice and create duplicate content (e.g. ❓Q markers appearing twice on each story).
- Fail with `old_str not found` because the first attempt already changed the content.

**Recovery procedure after timeout**: fetch → diff against intended state → submit corrective edit if needed, with `old_str` constructed from the actual current content.

## Block-anchor deep linking

In Notion, ANY block (paragraph, heading, bullet, callout, …) is anchorable via its block ID. Headings are NOT required. URL format: `https://www.notion.so/<page-id>#<block-id-without-dashes>`. Clicking scrolls to and highlights that block.

### What the MCP can and cannot do (tested 2026-05-12)

**Cannot do programmatically** (verified):

- `notion-fetch` returns markdown content; block IDs are NOT in the output.
- `notion-fetch` with `include_discussions: true` only surfaces block-anchored `discussion://` URLs when discussions already exist on the page.
- `notion-update-page` and `notion-create-pages` return only the page ID, not per-block IDs.
- `notion-search` with `page_url` returns page-level results, not per-block matches.

**Can do, but with a catch** (verified):

- Discussion URLs have the form `discussion://pageId/blockId/discussionId`. So `notion-create-comment` on a block + `notion-get-comments` reveals the block's ID via the URL.
- **Catch**: the MCP has no `notion-delete-comment` or `notion-resolve-comment` tool. Comments persist permanently. Polluting a doc with 30+ visible comments is worse than not having deep links.

### Workflow options for ❓Q-id hyperlinks

Pick one:

**(A) Default — page-level links, no hash.** All ❓ markers point at the Open Questions page URL (no `#<block-id>`). User uses Ctrl+F to jump to the Q. Zero cost. Good enough for most workflows.

**(B) Manual one-time paste — for stable Q lists.** Ask the human owner to right-click each Q block → "Copy link to block" and paste them all once. Capture in a `QX.Y → block-URL` mapping and wire into the simplified page. New Qs require one paste each.

**(C) Comment-harvest hack — only if you control the page and accept pollution.** `notion-create-comment` on each Q block, `notion-get-comments` with `include_all_blocks: true`, parse block IDs from `discussion://` URLs. **Comments persist** — re-evaluate before doing this on shared pages.

### Don't do this

- Don't restructure Open Questions to use H3 headings on the assumption that headings have predictable anchors. They don't — heading anchors are still UUID block IDs.
- Don't claim the simplified page has deep links when URLs are page-level. Be explicit in the page preamble.

## Editing tips

- Use a single `update_content` call with multiple `content_updates` entries for batched edits — atomic and faster.
- For inserting between existing blocks, `old_str` should anchor on the preceding block's last line AND the next block's start. `new_str` = same anchors + new content between.
- Keep `old_str` short enough to be unique but long enough to be unambiguous. ~50–150 chars is usually right.
- Headers: `###` for stories, `##` for personas. Code spans for function names. `*(italic)*` for research-derived flags.
- Preserve `**Source**` formatting — downstream tooling greps on it.
