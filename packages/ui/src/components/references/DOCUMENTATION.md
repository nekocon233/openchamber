# Reference picker

The picker for GitHub issues and pull requests and Linear issues, used by the
composer (any number of items, attached together) and by New Worktree (one
item, which names the branch). The issues and PRs board
(`components/sourceBoard`) lists the same items on a full page and acts on
them; see *Board* below. Extensions are not inside it: they draw their
own search in an iframe and attach through `host.attach`, so the + menu lists
every source, GitHub, Linear and each extension, as its own row.

## Invariants

- A close, reopen or merge through the app ends the item's label hold immediately, so the changed state can remove it from the list. A label hold restores a dropped item only in a label-filtered list; a drop from an unfiltered list is authoritative.
- Repository cache keys include the binding revision and resolved read context. An in-flight answer for an earlier binding fills only its earlier key.
- A forced value read waits for any read already running before asking again, so an answer from before a write cannot replace its follow-up.
- A batch read supplies an outcome for every requested key. An omitted key becomes an error, so it cannot remain pending indefinitely.
- The label panel reads once per opening even when the binding changes its reader's identity. Treating each new reader as another opening can loop reads.
- Comment edits preserve leading whitespace because Markdown uses it for indented code blocks.
- A thread write stays guarded until the preview reads the thread again. The pre-write thread still shown would otherwise let a second click act on stale state.
- An absent stack means the relation chain is unreadable or unknown; it does not assert that the item belongs to no stack.
- List-backed change-request size is available only with changed-file diffs, and pipeline totals only with CI jobs. A detail read without those inputs leaves the totals unknown.
- A followed tracker state can retain its existing id when its name changes. A transition to another state does not supply that state's id here.
- Unsaved comment drafts include the writing account's provider, instance and account id in their scope, with an empty account marker while unknown. Switching that scope closes the current editor. Comment and item draft stores each retain at most 20 drafts, dropping the oldest.
- Closing or unmounting the image viewer restores application shortcuts, including when its preview disappears while the viewer is open.
- A replacement scroll element owns a separate saved offset. Crossing the phone layout threshold or retrying a boundary must not restore an earlier element's offset into it.

## Decisions

### Why the picker remounts on open and not resets in effects

Each opening starts with the remembered tab and an empty search. Remounting establishes both before the first paint; effect-based resets would first show the previous opening's state.

### Why host text uses the composer editor without prompt tokens

Host text is Markdown source, where mentions name host users and file paths remain text. Prompt token resolution changes that meaning, and pasted-image uploads have no destination in a source-control text write.

### Why PR statuses subscribe through the store and not an effect

React checks the store version again after subscribing. This catches an answer that arrives between rendering a cached list and subscribing, which an effect subscription can miss and leave its row and preview loading.

## Files

| File | Owns |
| --- | --- |
| `useReferenceBrowser.ts` | The state both the picker and the board read: repository tab and filter, the provider's descriptor and term, search, highlight, the previewed item and its details, arrow and Ctrl+N/P keys. |
| `ReferenceBrowser.tsx` | The parts both lay out: tabs (repository source only, the change-request tab named by the provider's term), search filling the row with the one filter menu (32 px, like the tabs) whose panel also holds, for issues and change requests, the labels checklist, the list with its loading, failure, empty and not-connected states. |
| `useRepositoryLabelReader.ts` | Reading the filter's label choices, while its panel is open: the project the folder's repository is bound as, or the path its primary remote names for one nobody bound. |
| `labelWrites.ts` | Label sets the app wrote, held over the lists for two minutes so a lagging search index cannot bring the old set back. |
| `ReferencePickerDialog.tsx` | The picker around them: checked items, the diff switch, Enter/Shift+Enter, confirm. Desktop shows the list and a preview side by side; mobile opens the preview in place of the list. |
| `usePreviewReturnScroll.ts` | The phone's in-place preview: keeps the list's scroll position while an item takes its place in the sheet's one scroll area, and starts each preview at its top. |
| `ReferencePickerRow.tsx`, `ReferencePreview.tsx` | What a row and the preview show. State colours are the theme's PR tokens through the sidebar's rule (`lib/source-control/prVisualState.ts`). |
| `referenceSources.ts` | Which cache a list or a Linear preview comes from, and its key. |
| `referenceCache.ts` | Stale-while-revalidate lists and values. |
| `resolveComposerReferences.ts`, `useAttachReferences.ts` | Turning confirmed items into composer chips with their full context. |
| `referencePickerItems.ts` | Item union, keys, state looks, filters. |

## GitLab projects

The repository source lists the project's issues and change requests on
whichever provider hosts it. What the UI does with a provider comes from its
descriptor (`lib/source-control/providers`, *Provider registry* in that
module's documentation), never from its id:

- The read context is the one whose provider comes first by registry `order`
  (`useRepositoryReadContext`); the host named while no account works, and the
  provider a project is remembered under, follow the same order
  (`useRepositoryHost`, `useRepositoryReferenceProvider`). Remotes are
  recognised on each provider's default instance
  (`defaultSourceControlIdentities` in `lib/source-control/identity.ts`) and on
  every connected account's instance.
- `features.referenceSearch`: pages come from `sourceControl.references`;
  without it they come from the provider-neutral `issuesList` /
  `changeRequestsList` (`listBackedReferences.ts`, page number as cursor, the
  same state and whose-items filter). There a number (`#12`, or with the
  kind's own prefix, `!12`) or a link the provider's URL patterns read as an
  item of this kind on this provider is read on its own, not searched for; a
  link to another provider's item is searched as text.
- `features.referenceDetail`: the preview's detail comes from `referenceDetail`;
  without it from `issueComments` / `changeRequestContext`.
- `features.listStatuses`: open PRs' checks are asked with the list
  (`changeRequestListStatuses`); without it they come only from the followed
  live state (*Live state of listed items*).
- `features.projectUploads`: attachments are rewritten (`projectUploads.ts`).
- Wording and marks: the change-request tab, search placeholder, picker title,
  board title and not-connected text are chosen by the descriptor's term
  (`pullRequest` or `mergeRequest`) with its label as `{provider}`; the dialog's
  mark is `ProviderIcon`; numbers read with the descriptor's prefixes
  (`referenceNumberLabel`: `#12`, `!12`).

Every `RepositoryReference` names its provider: the web adapter
(`packages/web/src/api/repository-references.ts`) stamps the items it reads
with the read context's provider, and list-backed items take it from the
neutral issue or change request. The neutral issue carries no close reason, so
a closed list-backed issue reads as done.

### Why the read context waits for the provider list on a first visit

Which read a list or preview takes depends on the provider's features, and a
cache key does not carry the read path. On the very first visit to a runtime
there is no remembered list, so until the server answers every provider would
read as the generic fallback with every feature off: a GitHub project would be
listed list-backed, cached, and kept after the real descriptor arrived.
`useRepositoryReadContext` therefore answers "still loading" while the registry
holds nothing and has not answered; a failed answer with nothing held (`error`)
reads providers through the fallback rather than waiting forever.

### Why item keys carry the kind on every provider

`referencePickerItemKey` is in memory only. Choosing the marker from the
descriptor (`sharedNumberSpace`) would have to thread descriptors into every
caller that keys a selection (New Worktree, attach), while marking every change
request `!` and every issue `#` keeps keys unique on any provider: where both
share one number space only one of them can exist.

## Discussions

A provider whose descriptor has `features.discussions` (GitHub) gets a third
repository tab, Discussions, in the picker, the board's switch and New
Worktree; elsewhere the tab is absent, and a remembered Discussions tab reads
as Issues (`useReferenceBrowser`) once the host is known; until the provider
list and the project's host are known it waits on Discussions instead of
listing issues and switching. Discussions come only from the provider's
own search (`referenceSearch`, `referenceDetail` with `kind: 'discussion'`);
the list-backed reads have none and refuse the kind.

- The list loads only while its tab is open: the background read that makes
  switching between issues and change requests instant leaves discussions out.
- Filters: open, unanswered (open questions in a category that takes
  answers), closed, all; anyone's or the user's own, remembered per repository and kind like
  the others.
- State looks (`discussionStateLook`): open in the open colour, with a
  check while its answer is chosen; resolved in the merged colour; outdated
  and duplicate in the closed colour. Rows add the category (its emoji and
  name) and upvotes; the preview adds category, answer status, upvotes and a
  lock note.
- Comments are threads: each comment's replies sit under it, and on the board
  and in a Tracker tab each takes a reply (`threadActions`, `replyTo` the
  comment's id) and, in a category that takes answers, Mark or Unmark as
  answer where the host says this account may; the chosen one wears an
  Answer badge. The reply box at the bottom writes a comment of its own, and
  is left out of a locked discussion this account may not comment on. The
  state pill closes an open discussion as resolved, outdated or duplicate, or
  reopens a closed one, offered only while the detail does not say this
  account may not (`canChangeDiscussionState`); labels edit as one set.
- A conversation comment is edited and deleted from a "..." beside the
  send-to-agent button that shows on hover, and a thread's replies carry the
  same menu: Edit turns the comment's body into the composer's Markdown editor
  (`ReferenceMarkdownEditor`), seeded with its text, Enter breaking the line
  and Mod+Enter saving, and the host's own comment edit sends the trimmed text
  with that comment's id; Delete asks first in the app's dialog, naming what
  disappears, then removes the comment. Both are offered only where the
  surface passes `commentActions` (the board, a Tracker tab and the branch's PR
  tab do; the picker does not), never for a linked item, and only on a comment
  the host gave an `id` with neither a line nor a review verdict; the provider
  must also publish `features.commentEdit`, since posting a comment is not
  permission to change one (an extension declares it, and a host that only
  posts publishes none); Edit shows where `canUpdate` is not false and Delete
  where `canDelete` is not false, GitLab and Gitea answering an explicit false
  for someone else's comment. `sourceBoard/updateItemComment.ts` picks
  `changeRequestCommentUpdate`/`Delete`, `issueCommentUpdate`/`Delete` or
  `discussionCommentUpdate`/`Delete` by the item's kind, and each write reads
  the item again. One write per comment runs at a time, Cmd/Ctrl+Enter saves
  and Escape cancels, and a refused save keeps the editor open with the text
  and the host's message. A half-typed rewrite is kept the same way
  (`referenceCommentDrafts.ts`), under the runtime, the preview's folder (whose
  binding picks the account) and the item's URL as well as the comment id: a
  comment id is unique on one host only, so another host's or account's
  comment with the same id never opens on that text. A coarse pointer always
  shows the menu button, which hover alone cannot reveal.
- Attached, a discussion becomes a `repository-discussion` chip and context
  part: `Source control discussion context (JSON)` with the listed item (its
  description as the list cut it, `bodyTruncated` saying so), its newest
  comments with their replies and which one is the answer
  (`resolveComposerReferences.ts`). The session keeps it as an `external`
  link under its canonical address (`buildLinkedDiscussion`), the id an
  agent's link to it gets too, so every client keeps it and newer ones read
  it as a discussion: the sidebar and work status show it among the issues,
  coloured as an issue reads (resolved done, outdated and duplicate dropped).
- New Worktree starts from one the way it starts from an issue: a new branch,
  `discussion-<number>-<slug>`.

## Lists and the cache

The project PR host supplies each row's filtered file statistics through
`ReferenceBrowserList.renderPullFileStats` and the preview's Changes row
through `ReferencePreview.pullFileStats`. The project view owns the reads and
file-type exclusions. Picker and board previews use the provider totals.

Project PR rows use a title button that opens Changes when the provider serves
the diff. The Details button sits after the title in reading order and opens
the preview. For providers without a diff, the title opens the preview directly.
Reference pickers use listbox options for their selection model.

- The PR side panel uses `useReferenceBrowser` in `project-pulls` mode. Mine
  requests open PRs. All offers Open by default and Closed, which includes
  merged PRs. The active state bounds rows and status reads, including
  number and URL lookups and advanced searches.
  The saved project category is restored, defaulting to Mine, and
  legacy saved `reviewRequested` or `created` selections migrate to Mine.
  The panel validates Mine and All separately from the picker and board. It
  does not preload issues. It requests
  `scope=repository`. Existing callers keep `network`. Scope joins the list cache key. A hidden panel reads
  its cached list without fetching or revalidating; an explicit selection
  opens details, so the first row does not fetch a preview by itself. The
  selected PR is also retained as the opened item: revalidating the first page
  cannot discard a later-page preview or its unsent reply.
- Desktop GitHub PR links open the PR tool pane through the shared tracker
  entry point in `sourceBoard/openOnBoard.ts`. Chat, PR reference chips,
  sidebar badges and work-status PR rows reveal a tab with
  `openContextPanelTab`, so repeated clicks do not toggle it closed. A one-shot
  request names the hosting workspace and the source directory separately;
  the latter supplies the account and repository for the exact URL lookup and
  every detail or action. Links to closed and merged PRs open their preview
  from either category. The original list and branch
  views remain retained underneath the linked preview. Chips honor the chat
  link preference; their mobile, mini-chat, VS Code and modifier-click behavior
  remains external. Explicit host links remain external on every surface.
  Linked previews also record a return target when opening Changes. The existing
  Back to PR control restores their exact preview, reply and reading position.
  Cross-directory comparisons use the source binding and restore the original
  conversation or draft before revealing its retained PR pane.
- Each GitHub row in the project PR list shows its check result and count.
  Mine requires passing checks and confirmed mergeability without conflicts.
  Loaded candidates stay subscribed to status updates even when filtered out.
  Mine waits for the loaded candidates' status reads before paging. A failed
  status read shows Retry alongside any confirmed matches. All shows matching
  rows as soon as the page arrives and reads checks in batches for either
  state. Status cache keys include the PR state so a closed result cannot
  supply mergeability when a PR reopens at the same head.
- A confirmed GitHub merge conflict is named in the project list and PR
  preview. Failed checks, a required review and unknown mergeability do not
  imply a conflict. A directly opened PR reads its own status even when it is
  absent from the list. Explicit host refresh discards the affected binding's
  cached statuses, including answers still in flight.
- PR status readers expose a value snapshot to memoized rows. A completed
  request updates that snapshot without fetching again. A failed batch stays
  failed until a list refresh, revalidation or return retries it; successful
  batches remain cached.
- All uses GitHub's repository connection to page through the selected state
  when the query is empty. Searches use the existing
  search API. Lists retain the returned total so the panel can explain its
  1,000-result search limit and ask for a narrower search. A query cannot expand
  the repository scope, and a PR number never resolves to an issue in this mode.
- Repository pages must echo `scope=repository`. A server that predates that
  contract produces a translated restart notice instead of displaying its
  unscoped results. Existing network readers accept responses without the echo.

- A list is cached per key `[runtime, account or Linear workspace, project, kind, filter, search text]`. Switching tabs or filters, or reopening the picker, shows the cached list at once; one older than 60 s refreshes in the background and is replaced when the answer lands. `revalidateReferences` makes every mounted list, preview and PR status check its age again.
- A failed first load is an `error` state with Retry. A failed refresh keeps the shown items and shows the error above them. Failure never becomes an empty list.
- Every first-page request bumps the key's generation; an answer or a later page from an older generation is dropped.
- The paging sentinel resumes after each successful page, including a page with
  no visible items after membership filtering. A failed page stops automatic
  paging until Retry, preserving the items already read.
- A forced refresh that arrives during a first-page read waits for that read,
  then performs a fresh one. Clearing the cache retires queued refreshes and
  old responses. Deferred page readers check their runtime before dispatch.
- A successful review invalidates the matching runtime and repository binding's
  project PR lists, preserving their visible contents until a fresh answer lands.
  An in-flight read is retired and the next active read waits for it before
  fetching again. Other accounts, repositories and filters retain their data.
- Keys someone is subscribed to are never evicted; the 40-entry bound is a soft target.
- After a label write through the app, the written set holds over every list showing the item for two minutes (`labelWrites.ts`): a host whose lists come from a search index (GitHub) can answer the old set for a while after the write succeeded, and a re-read must not bring it back. The written set also decides whether the item belongs to a label-filtered list: it leaves one it no longer matches, and comes back at its place in the list it was edited in when that list's answer dropped it while it still matches. A write replaces the whole set, so a succeeded receipt is the set the host holds; colours come from the item's labels and the repository's list the picker read.
- The end of the list asks for the next page each time a page lands while it is still in view, not only when a row is added: a host that narrows on its own side after reading (Gitea's labelled pull list, the review-requested search) can answer a page that keeps no row. The empty text waits until there is no next page. A failed page waits for Retry.
- Searched pages come from `sourceControl.references`, `GET /api/source-control/<provider>/references` (server: `packages/web/server/lib/github/DOCUMENTATION.md` for GitHub); the preview's detail from `referenceDetail` and PR colours from `changeRequestListStatuses` go through the same provider prefix, read with the project's read context (`useRepositoryReadContext`): the account its binding names, or the current account of the host for a repository nobody bound. List and preview cache keys carry that account. Tracker lists use `trackers.list(provider, …)` with the filter's state, whose items (`me` or `created`) and priority, combined; picking in the filter menu keeps it open. The state menu is the descriptor's `stateFilters` in its order (Linear adds In Review and Duplicate), and people and priority appear only where the descriptor's `capabilities.filters` offers them; a filter the tracker does not offer reads as its default. The last filter is remembered per tracker for the app run.
- On a phone the filter is one bottom sheet (`MobileOverlayPanel`) with the same parts as sections, the label search among them; opening it leaves the keyboard closed until the search is tapped, and picking keeps it open.
- Labels narrow the list from the one filter menu (`ReferenceBrowser.tsx`), in a section under People: a search field over the host's labels, each with a check, and a Clear row once any are chosen. Each check or uncheck applies at once — `selectRepositoryFilter({ labels })` with the whole selection, kept per repository and kind — and the panel stays open for the next one. The trigger names the chosen labels in its summary (`Open · bug`, then `Open · bug +2`), and its tooltip lists them all; nothing beside the trigger is a second control. A chosen label the host no longer lists still shows checked and can be unpicked there. Labels are read with `sourceControl.referenceLabels` for the repository's project when the panel opens and never on mount; a read still loading shows a spinner, a failed one shows the failure and leaves the selection as it was, and the empty answer says there are no labels. Issues and change requests offer the section; a discussion and a tracker do not, and neither does a list across repositories, which has no single project to read labels from and is never narrowed by a set remembered from one repository (the across request and its cache key leave `labels` out). The search field keeps its own typing and arrows (the list is `Command`, and the field stops the menu's keys from eating them) while Escape still closes the panel.
- The state, people and labels filter is remembered per resolved repository and tab in `openchamber.repositoryFilters.v1`, keyed by the repository's provider, instance and `owner/repo` as `repositoryFilterKey` resolves them: two clones of one remote share an entry, and a fork clone and its upstream keep separate ones whenever their resolved coordinates differ. It is restored before the list's first read, which waits for it (`filterPending` in `useReferenceBrowser.ts`), not when the panel opens. VS Code shows neither the board nor the composer's linked-reference chips, so the filter is unreachable there. Labels are capped at 20. There is no entry for the list across repositories, and a saved state or people the tab no longer offers reads as that field's default rather than being sent.
- Where the host parses qualifiers out of the search text itself (`descriptor.features.advancedSearch`, GitHub only), the field names them in its placeholder and the controls those qualifiers decide read as taken over: typing `is:closed` or `state:` names the status group after the qualifier (`Status · is:closed`), ticks none of its choices since the control no longer decides, and disables them, typing `assignee:`/`author:`/`mentions:`/`review-requested:`/`reviewed-by:` does the same for people. The host applies the typed qualifier and ignores the control, so the control must not pretend to decide. Labels are not marked: a typed `label:` and the checklist both narrow the same list, and the list builder drops a typed qualifier it would otherwise repeat.

- An open PR turns orange on failed checks or a conflict, as in the sidebar; checks still running keep the open colour. A page does not carry that (mergeability alone made a 30-PR page about three times slower), so once the list shows, `useRepositoryPullStatuses` asks `references/status` (where the provider has `features.listStatuses`) for the open PRs it lists, ten per request and all at once (a whole page in one query takes GitHub about ten seconds, at the edge of the request timeout), and the rows and the preview recolour when it lands. The preview's Checks line shows the same status as the row; until it arrives, the previewed PR's own detail carries its checks (GitHub's head-commit `statusCheckRollup`, summarized like the batch; GitLab's pipeline). On the board the totals open `SourceBoardChecksDialog`, which reads the PR's runs, steps and failed annotations through `useChangeRequestContextStore` (the PR panel's cache) when it opens, and again while runs are still going. `components/views/git/CheckRunList.tsx` draws the runs for both. Statuses are cached per PR and head commit. Until a status arrives, or when it fails, a PR reads as open.

### Why a written label set holds for a while and not until a read agrees

A list read that agrees with the write does not prove the next one will: the server answers lists from a short-lived cache, and the search index can still serve the old set to another page or filter. Holding for a fixed two minutes covers the index's usual lag, and ending the hold then keeps a later change made on the host's own site from being hidden. Returning the host's own label list from every provider's write would change the mutation result contract of each host and extension for a set the succeeded receipt already confirms.

## Live state of listed items

A list and the statuses asked for it are what the host said when they were
read. While a surface is on screen (the picker, the board while open, a
Tracker tab while shown), the open items its list shows are also followed
through the server's tracked items (`liveReferences.ts`, `lib/trackedItems`,
server `tracked-items`), the same live state behind the sidebar's badges: the
server reads them on a cadence (30 s while checks run), after an agent turn,
after a change made through the app and on the board's refresh, and pushes a
state only when it moved. A followed state answered after the list was read is
laid over the row: a PR's state, draft, title, head commit, checks and
mergeability, an issue's state and title, a tracker item's state (name and category) and title. A
GitLab merge request gets its pipeline colour this way, which no list status
carries.

- Followed items are read with the account the list was read with
  (`accountId` of the read context), so the same PR on the sidebar and the
  board is one item on the server.
- Each page of a list, and each PR status, counts as read 30 s before it
  arrived, the age of the server's own short-lived answers
  (`provider-read-cache`), so a followed state from just before it still wins
  and an older one never does. A read forced after a change or a refresh
  (`ReadStamp.forced`: a retry, the read after a write) is answered anew and
  counts from when it arrived, so a change the user just made is never
  replaced by the state from before it.
- Mine uses a followed PR status only when its head matches the listed head.
- At most the first 50 open items of a list are followed (the server reads
  GitHub PRs 25 to a query, sequentially); the client sends
  at most 300 items in all, the server's limit, the surfaces declared first in
  full. The list on screen is followed, never the other tab loaded in the
  background or a board kept mounted while closed.
- What joins or leaves a list (a new PR, a PR merged out of an open filter)
  still waits for the list to be read again: on open, on window return and
  after an agent turn finishes, for lists read more than 60 s ago.

### Why followed items and not reading lists again on a timer

A list that stays on screen used to show what it read until the window lost
and regained focus, so a PR whose checks finished meanwhile stayed orange. A
client timer would read whole pages (GitHub search, ten-PR status batches) and
send them over a relay that is paid per byte even when nothing changed. The
server already follows the sidebar's items on a state-based cadence and pushes
only changes, so listed items join that set; the sidebar, the board and the
Tracker then show one state for the same PR.

## Preview and attach

- Desktop previews pin the item header above its divider and the action footer below the scroll region. The metadata grid, description and comments scroll together for repository and tracker items, a divider below the grid as on mobile. Mobile keeps the whole preview in one flow. Where the phone shows the preview in place of the list, in one scroll area, it starts at its top, and the list's offset is kept while it is away and restored before the return paints (`usePreviewReturnScroll`).
- The preview shows the list item at once and asks for the rest of the item the highlight rests on (250 ms after it stops moving): GitHub comments, and a PR's size, review and newest commits, from `references/detail` with the same read context (a GitLab merge request's pipeline, commits and verdicts come with its detail, read with `includeTimeline`); a tracker item's description and comments from `trackers.get(provider, id)`. Both land in value caches: going back to an item shows what was already read at once, without waiting out the 250 ms, and attaching a previewed tracker item reuses the answer.
- An issue's, discussion's or change request's title and description edit in place: a pencil beside the preview's refresh button turns the title into a one-line field and the description into the composer's Markdown editor (`ReferenceMarkdownEditor`: Markdown source, no chat tokens, no pasted images), seeded from the item and, where the detail carries it, the whole description. The host's own edit sends the trimmed title with the body (`issueUpdate`, `changeRequestUpdate`, `discussionUpdate`), then the item is read again. The pencil is offered only where the surface passes `onSaveText` (the board, a Tracker tab and the branch's PR tab do; the picker does not), never for a linked item, only where the provider's features allow that kind (`issueEdit`, `changeRequestEdit`, `discussions`), never where the detail says this account may not update it, and never on a list body cut at 20 000 characters when the detail brings no whole one. The title row carries its own **Save** and **Cancel** beside the field; Enter in the one-line title saves (a description keeps Enter for a new line), Cmd/Ctrl+Enter saves from either field, Escape cancels, and a save already in flight does not start again. Save and Cancel sit on the title row, and on a coarse pointer they sit under the description too, since the title row scrolls away. Unsaved text is kept per item and runtime in `referenceTextDrafts.ts` and restored when the editor opens again; Save and Escape drop it, and the keyboard returns to the pencil. The board shows the next row in the same mounted preview, so the open editor and a save in flight belong to the item they started on: another item shows its own text, saves through its own `onSaveText`, and is neither held nor closed by an earlier item's save finishing.
- A PR's thread is its activity (`referenceTimeline.ts`): comments, review verdicts and commits by time, commits in a row grouped, so a review reads next to the commits it answered. Comments made at the same moment as a commit come first. Each commit names its author: the host account with its avatar on GitHub, the name git recorded on GitLab.
- Descriptions and comments render with `allowRawHtml`, the Files preview's allowlist: GitHub's `<img>` screenshots, tables and `<details>` show, scripts, styles and author classes are dropped. An image with both `width` and `height` scales by its ratio. The Linear panel and the Git view's PR section render GitHub and Linear text the same way.
- Clips draw as players: a Linear upload written as an image named `*.mp4` (or `.m4v`, `.mov`, `.webm`), a GitHub `user-attachments/assets` URL alone on its line, and a raw `<video>`. One the browser cannot load, such as a private repository's, becomes a link to it; one signed with the URL token first retries with a fresh token where it stopped (`chat/markdown/markdownVideo.ts`).
- GitLab writes an attachment as a project path, `/uploads/<secret>/<name>`, readable only by signed-in members. `gitlabUploads.ts` rewrites those paths in the displayed description and notes, outside code: a picture or clip to `GET /api/source-control/gitlab/uploads/:secret/:filename` with the preview's read context and the URL token, kept fresh while a GitLab item is shown; a link to any other file to the file on GitLab. The text attached for the agent keeps GitLab's path. That is why `ReferencePreview` takes the item's `directory`.
- Attaching reads the full context the agent receives through the provider-neutral source-control reads (`issueGet` + `issueComments`, `changeRequestContext`) with the same read context: issue with all comments, PR context with the diff only when "Also send the diff" is checked for that PR, Linear issue with comments. Chips and context parts use the provider-neutral kinds `repository-issue` and `change-request` (with its provider). Each item resolves on its own; the ones that fail stay checked in the picker with the reason, the rest attach.
- Linear sub-issues: a sub-issue's row names its parent above the title, a parent's row shows how many sub-issues are finished (`2/5`, or `20+` when the list counted only the first 20). The preview has a Parent row and, once the detail lands, a Sub-issues section. Clicking either previews that issue through `openItem`, kept like a pinned item while the list does not hold it; the picker and the board both pass `onOpenLinearIssue`. A parent or sub-issue comes without labels, so the preview takes labels and parent from its detail when it has one. The agent gets the parent and sub-issues with the issue's JSON.
- The composer keeps attached items as a list (`chat/composer/composerReferences.ts`). The same item attached again replaces its chip in place.
- An attached item carries no guessed intent: the agent gets a one-line label of what it is and its content, with no hidden instruction or canned "review this" prompt, and the user writes what they want. Every flow that starts from an item (an issue, PR, tracker item, discussion, extension item, failed check or PR comment) opens a draft with the item as a composer chip and sends nothing on its own; a session started with a canned prompt would also run on a model nobody chose. New Worktree creates the worktree and hands the item to the new draft's composer; editing the branch name keeps the item, and only the chip's unlink button drops it (`NewWorktreeDialog.tsx`). The board's start actions do the same (`SourceBoardActions.tsx`). A button whose label states the intent (generating a commit message or a PR, resolving conflicts, plan flows) keeps its prompt. A new flow that sends a canned prompt with an attachment is turned into a plain composer attachment.

## PR window restoration

The PR tool passes a workspace/account-bound state owner to `useReferenceBrowser`.
Its project category remains independent of picker and board filters. All's
state, query, selected URL and loaded depth belong to the workspace binding.
A selected URL is resolved afresh before its preview can act. A new selection
supersedes an older lookup, and returning from Changes can select an item absent
from the list. Category, status and query changes reset list positioning.
Revisiting or restarting restores the current position.
PR preview scopes retain discussion expansion, unfinished thread replies,
ordinary replies and check-dialog visibility. Reply text is acknowledged only
after the provider confirms the corresponding write.

## Keyboard

Arrows and Ctrl+N/P move the highlight from the search field. Enter attaches the
checked items, or the highlighted one when nothing is checked; Shift+Enter
checks the highlighted item. Double-click attaches a row.

## Runtimes

Web, desktop and hosted mobile use it as above; Capacitor mobile gets the
in-place preview layout. VS Code never opens it: the composer offers only files
there.

## Board

`components/sourceBoard` is a full page over the chat area, opened from the
sidebar header (desktop and web, and the phone shell's menu; not VS Code). It
uses `useReferenceBrowser` and the shared parts without checkboxes; the
preview's footer holds actions instead of what the agent gets.

- The board keeps its own project, tab and Linear team per runtime
  (`stores/useSourceBoardStore.ts`). Switching them never changes the app's
  selected project.
- On desktop and web the board stays mounted once opened and is only hidden
  (`invisible`, `inert`) while closed, so it reopens where it was left,
  whichever way it was opened (its button, a link): the previewed item, the
  search, both scroll positions, a reply draft. A reopen puts focus back in
  the search. A new project or tab still starts a fresh list. The phone's
  board page is not kept. It draws its own header: the close button and the
  scope picker share one row, then the switch, then the search with the
  filter beside it; an open item puts a back button and its number in that
  header instead, and takes the list's place in the same scroll area, which
  returns to where it was (`usePreviewReturnScroll`).
- What the board shows stays current through `sourceBoard/useBoardRevalidation.ts`
  and the followed live state (*Live state of listed items*). While the board
  is on screen, lists, the preview and PR statuses read more than 60 s ago are
  read again when it opens, when the window gets focus back and when an agent
  turn finishes.
- The repository tab is the project's host only, the provider
  `useRepositoryHostProvider` names. A tracker gets a tab only while an account
  is signed in (`useTrackerSources`), named by the descriptor's product name; a
  served tracker nobody signed in to is connected from Settings, which lists
  every served one. A project with no remote on a known host shows its
  connected trackers alone, or the no-source note with the project pickers
  when none is connected: an unconnected tracker tab lists nothing, and the
  board remembers its project, so such a tab would leave nothing leading back.
  `resolveBoardTab` (`sourceBoard/boardRepository.ts`) decides. Until the
  folder says whether it holds a repository and until every served tracker's
  status first arrives (`useTrackerSourcesPending`), the board shows a loading
  state instead of guessing. A failed status read is not a disconnect: it ends
  the wait, and the tracker keeps its tab if it was signed in before.
- On a tracker the scope picker is the container picker
  (`SourceBoardContainerPicker`). When the project offers no repository tab,
  the project and repository pickers stay beside it: they are the only way
  off the tracker for that project.
- The board reads one folder, `useBoardRepository` (`sourceBoard/boardRepository.ts`):
  the project's root when it is a git repository, unless a repository under it
  was picked. When the root is not one but repositories lie under it, the board
  reads one of them, or all of them together. A second picker beside the project
  picker (`SourceBoardRepositoryPicker`, a bottom sheet on the phone) chooses;
  it appears only when there is something to switch to (`choosable`), so an
  established root with nothing below it keeps its own row alone.
  Discovery is the Git store's (`ensureNestedRepos`), read only: the board never
  calls `selectNestedRepo` for browsing, so its choice is independent of the Git
  screen's. The choice is per project id in the persisted board choice:
  `repositoryByProject` (the single repository) and `allRepositoriesByProject`
  (whether all are listed; absent means all, unless a single repository was
  remembered before this existed). Updates merge into both maps, older data
  reads as empty. A remembered repository that is no longer discovered falls
  back to the first, which under an established root is the root itself. While
  the root is probed and the folder searched, a root without a remote shows a
  loading state instead of the no-remote one; a failed
  search shows an error with Retry and is never read as "no repositories"; a
  runtime without discovery (`'unsupported'`) stays at the root.
- **All repositories** is the picker's first entry and the default for such a
  folder, offered only where `sourceControl.referencesAcross` exists and the
  root is no repository (`allAvailable`): an established root lists itself, and
  "all" of its repositories would only be the same one beside itself. A
  runtime without the route lists the first repository. Every runtime that
  mounts the board has it; VS Code has no board. The list, its search
  (including a pasted link or `#number`, which the server resolves) and paging
  come from one `referencesAcross` call per page
  (`useRepositoryAcrossReferenceList`) to one provider: the lowest-`order`
  provider among the folders' read contexts that has
  `features.referencesAcross`, with the contexts of the folders on it,
  gathered by `useRepositoryReadContexts` (one hook over the folders' bindings,
  `useRepositoryBindings`, not a loop; `partitionAcrossContexts`). It waits
  until every folder's context is known; its cache key carries the set of
  contexts asked, so a change in it lists again. A folder on another provider
  (`unsupportedProvider`, named) or one with no readable context is not sent; one the answer skips (`no-repo`, `disconnected`,
  `invalid-context`, `error`) is reported with the page (`ListPage.skipped`),
  and a later page adds to that list rather than replacing it. When the answer
  read no folder at all, the list fails if any folder failed, and otherwise
  reads as disconnected or as having no repository: a failure never shows as an
  empty list. A
  quiet note above the rows (`SourceBoardAcrossNote`) counts the repositories
  left out of the list, and its menu names them with the reason. Rows name
  their repository (the upstream-chip pattern, shown on every row). Each item
  carries `directory`, the folder it was read through, and everything per item
  uses it: detail (`useRepositoryReferenceDetail`), the read context of merge, ready,
  close or reopen, labels, reviewers, reply and the checks dialog, and Changes
  and Walkthrough. Open PRs' checks are asked per folder, each group through its
  own context and in batches, and a group that fails leaves the others
  (`ensurePullStatuses`). The pure parts are in `references/acrossRepositories.ts`.
- A repository link opened on the board (`repositoryFocus`, the phone and a window
  with no folder on screen; desktop opens links in the Tracker) from a session
  in such a folder lists all repositories first (`choiceForFocus`, decided in the board
  because discovery lives there, so it waits for the probe and discovery and the
  pinned lookup never runs against a stale single repository), remembers that
  as the project's choice, and opens the item in its own repository. A root that
  is a repository has nothing to list across, so the item is read through the
  repository its link names instead (`useLinkRepository`, the folder rule the
  Tracker uses): a submodule's item opens from an established root's board, its
  labels, comments and Changes links belonging to that repository, while the
  list and the remembered choice stay as they were. A runtime without the
  search is unchanged.
  Link lookup waits for repository discovery and candidate bindings unless the
  root already matches the link. Failed discovery keeps the link with Retry;
  it never triggers the external-browser fallback. The home directory is never
  scanned, including on retry, and cached discoveries there are ignored.
  Repository focus stays in the store until the preview opens and discovery
  settles, so resolving a remembered child can remount the list without losing
  the request. A discovery failure on a repository root leaves its list usable
  and shows a separate Retry even when no link is pinned.
- With one repository chosen (or a folder that is one), lists, preview, labels,
  reviewers, reply, merge and the other writes use that repository's read
  context. New session and Attach keep the project's root. Changes and
  Walkthrough of a PR from a repository under a root that is not one open a
  tab with that repository as `targetDirectory`, the request keyed by it
  (`resolvePullLinkTarget`, for the item's `directory`), so the views read the
  PR there and the Git screen's nested selection never moves; a session
  already inside the repository reads it as its own. The phone's Changes takes
  the request under the normalized folder the app shows, with the repository
  beside it (`usePullRequestSelectionStore.changesRepositories`): it shows that
  repository in place of the Git selection until the next request for the
  folder or a repository picked in its picker. Worktree actions (check out a PR, start an issue in a worktree) are
  not offered for these items: creating one needs the project itself to be a
  repository.
- The toolbar is one row: the scope (a project picker with icons and search,
  like the draft composer's; a team picker on Linear, with the workspace in the
  same menu when there is more than one), one switch for Issues, Pull requests
  and Linear, then the search and the filter. The preview's footer is one row:
  where a Linear issue starts and a PR's merge or ready on the left, and one
  Attach to session menu on the right: the open session (when the chat shows
  one, not a draft; the board closes and its composer takes the chip), a new
  session, or a new session in a worktree.
- Linear lists one team or all. An issue starts in its team's mapped project
  (`resolveLinearMappedProjectPath`), else the mapping's default, else the
  board's project; the user can pick another for that issue. Its state pill
  in the preview opens the tracker's state choices.
- An issue, GitLab merge request or Linear issue a session links to opens on the board, selected:
  from the work-status panel and from the sidebar's badges and their tooltips
  (`sourceBoard/openOnBoard.ts`), and from links in chat while
  `openTrackerLinksOnBoard` is on (`chat/useOpenChatLink.ts`). The board moves to the session's project and
  tab and previews the item, read on its own (`focusRepositoryItem` with its
  link, `focusLinearIssue` with its identifier, then the browser's
  `pinnedItem`) while the search stays empty and the list as it was. A link
  finds that one item whatever its state, on GitLab too, where a number or link
  is read rather than searched. The board takes from that answer only the item
  whose link names the same repository and number, never just the first row, and
  each request is shown once, so the item shown for the previous link never
  answers for a new one. Chat link requests carry `failureBehavior: 'manual'`:
  loading and failed lookups replace the preview with `SourceBoardLinkFeedback`,
  retaining the original URL with Retry and an explicit external-browser button.
  A failed chat link never opens a browser automatically. A request outside chat
  keeps the automatic behavior: an unknown repository link opens externally and
  an unreadable Linear identifier is searched for. The phone shows link feedback
  in its preview page too. Cmd or Ctrl-click and VS Code use the external link.
  GitHub PRs use the desktop PR pane described above; mobile keeps the board.
  A chat whose project or integration cannot open its tracker view shows a notice with
  a manual external action. A badge's `+N` does nothing; its tooltip lists the others.

- General settings offers two destinations for chat tracker links, backed by
  the existing profile boolean `openTrackerLinksOnBoard`: true is OpenChamber,
  false is the external browser. External tracker links bypass the ordinary
  desktop `openLinksInBrowserPanel` preference. Existing values and the initial
  true default are preserved. Mini chat uses external links. The Markdown
  renderer and web-search result cards share `useOpenChatLink` for this choice.
  `sourceBoard/boardLinkTarget.ts` owns URL classification and repository-item
  equivalence without React or store imports, so Markdown can classify a link
  without loading the board. User Markdown selects tracker-only routing;
  its ordinary HTTP links keep their browser behavior.
- A PR's review threads read as the comment that opened them with the
  replies under it (`ReferenceCommentItem.thread`); a reply is not an entry of
  its own. A resolved thread folds to one line ("Resolved · N replies") and
  opens on click; resolving folds it, reopening unfolds it. On the board
  (`threadActions`, `sourceBoard/threadActions.ts`) a thread can be answered
  and resolved or reopened, as far as the host says this account may. GitLab
  merge requests can also start a thread from the reply box; GitHub threads
  start only from a line in a review, so GitHub has no such button.
- The board's issue or PR preview has a refresh button beside the host link
  (`onRefresh`). It asks the server to forget that host's short-lived answers
  (`sourceControl.refreshProviderReads`, `POST <provider>/read-cache/refresh`)
  and then reads the item's detail and the list again, so a change made on the
  host's own site shows without waiting out the cache. VS Code has no board and
  answers the call as unsupported.
- The project PR list refresh button uses the same provider-cache invalidation
  before its forced list read. It stays busy through both operations and keeps
  the displayed list on failure. Mine combines PRs authored by the viewer with
  review-requested PRs whose membership comes from the
  provider's current pending user or team requests, checked in the repository
  page query even when search membership lags behind a completed review. A
  number or URL search in this category obeys the same check. Approval alone
  does not close a PR in the All list. After a review receipt, the affected
  binding's cached lists and statuses become stale and the visible list reads
  its first page again. A failed provider cache flush still lets the list read
  and show its own result or error.
- The side panel and its rail stay beside the board. A board under 960 px
  wide shows the kinds by icon and drops the list column: a trigger left of the search names the previewed
  item (`#12`, `!12`, `ENG-7`) and opens the list as a dropdown over the
  preview; typing in the search opens it too, and picking a row, Enter or
  Escape closes it. The search then takes a row of its own.
- `toggle_source_board` (`mod+k b`) opens and closes the board; the command
  palette lists it too.
- Actions: start in a worktree (New Worktree opens with the item chosen,
  `initialSelection`), a new session in the project with the item attached,
  and for a PR its Changes (`usePullRequestSelectionStore.requestDiff` hands the
  PR to the diff view's PR scope), Walkthrough, Merge (one split button named
  after the remembered method, the arrow picks another; asks first) and Ready
  for review, and Close or Reopen for an issue or a PR that is not merged, in
  the menu of the preview's state pill (no confirmation: both are reversible). Changes and Walkthrough open
  in the folder the app shows when it belongs to the project, else in a new
  draft of the project. The phone offers Changes only: it closes the board and
  opens the workspace drawer's Git tab, whose PR mode takes the request
  (keyed by the normalized folder) the way the desktop diff view does.
- Labels and reviewers (`SourceBoardMetaEditors`, `SourceBoardChoicePicker`):
  the preview's Labels row (shown empty too) and an open PR's Reviewers row
  get a pencil that opens a searchable checklist, read when it opens. The new
  set is sent once, when the popup closes, so several clicks are one change;
  a GitHub PR's author is not offered as its reviewer.
- Reply (`SourceBoardReply`, GitHub and GitLab items): below the activity a
  comment box; on an open PR also Approve and Request changes,
  for the head commit the preview shows. The box is keyed by the item, so a
  draft never moves to another one, and keeps its text until the host has it.
  After a write, and after a refused review (usually a push since the
  preview was read), the item's detail is read again (`ensure(..., { force })`
  after any read already running) and the list refreshes.
- Attach (`sourceBoard/pullAttachments.ts`): a comment (on hover), all the
  comments shown (from the Activity heading) and, in the checks dialog, the
  failed runs with their steps and annotations are pinned above the composer
  as inline drafts (`pr-comment`, `pr-check`), the way the PR panel always
  did. They go to the session in view or a new session's draft; with neither
  open, a toast says so.
- Pending GitHub review (`sourceBoard/usePendingReview.ts`,
  `PendingReviewSection.tsx`): Changes and the PR reply share one read per
  runtime, bound account/repository context and PR. The section lists saved
  inline comments, allows edits and deletion, and submits them with a summary
  as Comment, Approve or Request changes. Discard requires confirmation.
  Saved comments come from GitHub; unsent summary and edit text remain local
  under that same scope. Active views revalidate on return and after a write,
  with no polling. Read failures keep the last complete review and disable
  submission until a fresh read succeeds. Uncertain writes retain their
  original payload and idempotency key for an explicit retry, even when the
  first comment's response was lost and a refresh discovers the new review ID.
- The PR panel (`views/git/BranchPullRequestPreview.tsx`) shows the checked-out
  branch's open PR with this same preview: no new-session or worktree actions,
  since the branch is already here. `PullRequestSection` keeps the create form
  and the merged/closed state. The form is one row of branch → base (picked in
  place), the title (a one-commit branch is titled by that commit until edited),
  the description with Generate on it (its arrow adds notes only the generator
  reads), and a split Create button whose arrow picks a draft, remembered. The
  host makes the PR from what the remote has, so an unpublished or ahead branch
  is pushed first through the Git view's own publish path (`useBranchPush`) and
  the button says so. The PR comes from the branch status; on GitHub
  `#N` is also looked up for its labels and comment count, which the status
  does not carry.

