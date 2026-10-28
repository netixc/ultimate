Fleet keeps the instance switcher beside Ultimate while moving between known projects and configured remotes.

The supported placement is `<Ultimate-checkout>/.ultimate/extensions/fleet`; Fleet uses that checkout's host code,
dependencies, and test runners. It is not a standalone application or a portable extension for other project roots.
There is provisionally no independent Fleet GitHub Actions CI; the Ultimate host runs the packaged tests.

The approved visual reference is artifact `fleet-switcher-concept`, bundle
`e16cd2bc27ca97e3abe4ac58c317ede5dfd05223cc14456025568e322afa5797`.

Fleet uses one menu, 56px compact and 250px expanded. The yellow badge is the original home instance's @ultimate
waiting-on-you count, never an offline-device or project sum. Purple dots mean work in flight in the project,
matching the sidebar's In flight section. The eye marks are decorative reference marks with no implemented behavior.

Opening and pinning survive Fleet instance switches in the same tab. Until Fleet first appears, an unconsumed
navigation fragment finishes that switch even after an automatic or manual reload. Fleet then removes the fragment;
a later full reload starts expanded and unpinned.

## Backend actions

- `inventory({ origin?: string } | null)` returns `FleetSnapshot` from `types.ts`: the current home plus known local
  projects and user-configured `remotes`. `home` initially means the current project; the browser retains the original
  home across switches. Project identities hash the registry home internally; filesystem paths never leave the action.
- `snapshot(null)` returns `{ machine: { id, name }, project: { id, name, url?, port? }, inFlight: boolean, awaiting: number }`.
  This read-only response contains no conversation identifiers, titles, text, timestamps, paths, read receipts, or UI
  documents. Machine identity is the host's hostname. A published URL comes only from the existing ready Tailscale
  service; no cloud discovery, settings writes, or network discovery run here.

Inventory requests this minimal snapshot through the existing `postAction` transport, only from local live registry
URLs or owner-configured user remotes. The browser cannot supply a request target. Duplicate URLs are queried once;
successful snapshot machine/project identities merge configured aliases. A failed endpoint stays listed with
`available: false`, and its failure is logged. Stopped local projects stay listed without a request.

The current project uses `/` for same-origin navigation. Other local loopback addresses are returned only to a
loopback-origin browser; a phone receives a peer's published URL or no link, never an invented public-port mapping.
Configured and published addresses must be HTTP(S) without credentials; fragments are removed. The caller's `origin`
is only a reachability hint and is never fetched.

`inFlight` uses the sidebar's open-branch convention, not unread answers and not merely whether a turn is busy.
An idle unlanded branch still counts. Workspace queue membership or new input after landing reopens work; a landing
since the latest input closes it, using both retained workspace outcomes and the roots' latest 20 landing notes.
Only branches reachable from listed, unconcluded roots count; concluded ancestry hides the whole subtree. Foreground
work and busy descendants follow the sidebar's working/parked convention. The pure `inFlight` and `stillOpen`
predicates are shared with the sidebar through `lib/in-flight.ts`. Read receipts are never read or written by Fleet.

Every project row's `awaiting` comes from that instance's existing `MessagesApi.openQuestions(context).length`.
This uses the same delivered, reply-enabled questions to the user as the sidebar's @ultimate waiting-on-you counter;
answered, dismissed, one-way, not-yet-delivered and agent-to-agent messages do not count. Only @ultimate may send
messages to the user. Neither workspace submissions, unread answers nor other projects' questions contribute.
The original home's badge must read its matching known project row after switching, not the newly current
`inventory.home` row and not a sum. Unavailable project rows have no fresh awaiting evidence (`available: false`).
No message content or identifiers leave the snapshot. `FleetSnapshot` has no `offlineDevices` counter.

A responding snapshot proves that device online. Failed, refused (including 403), missing, or timed-out instance
endpoints do not prove its device offline. Unknown devices have `online: null`. The optional existing Tailscale
service reads reported peer status only for configured remote hosts. An exact offline match makes its projects
unavailable without HTTP requests; its opaque peer identity deduplicates ports and configured aliases for group
status only. This is Tailscale-reported offline, not proof that the hardware is powered off. Missing or ambiguous peer
data remains unknown. Device status never supplies the yellow badge. No eye flags are inferred for real machines.

The browser refreshes inventory on mount, conversation scope changes, existing local messages/workspace/root/activity
updates and returning to the tab/window; there is no polling interval. Changes coalesce while an inventory is pending
rather than repeatedly cancelling a slow remote request. Small navigation state retains the original home name, port,
URL and known host/project identity, so selecting its published address does not lose its awaiting count. If that home
is absent or inaccessible, another instance's count is never substituted; no carried home URL is fetched.

Fleet awaits `prepareInstanceNavigation()` before leaving. Draft images stay in origin-local IndexedDB; a tab-local
session header holds text, ready attachment metadata and image identifiers, never image bytes. Drafts never appear
in navigation URLs or cross origins. A native Web Lock owns each writable journal; a live duplicated tab forks and
copies its images before writing or deleting. Ordinary reload reuses the existing journal without rewriting images.
If a copied tab starts after its original image bytes were replaced or cleared, restoration fails explicitly and keeps
its copied pointer and the source unchanged; an incomplete draft is never silently accepted or automatically resaved.
Old image versions are not retained to recover such a copy.
Explicit removals take effect synchronously, including when an IndexedDB write fails. Restoration keeps the current
unsent journal available until a mutation replaces or clears it. Failed preservation leaves Fleet in place with an
existing application error notice; unavailable browser storage or Web Locks rejects rather than silently losing work.

The browser's native unload confirmation is installed only while actual unsent work is not safely preserved, including
pending image writes or failed session-header writes. Successful preservation or clear/send removes it. It is not a
browser/OS-crash guarantee, and the user can still choose to leave unsaved work. No expiry is imposed on unsent drafts;
permanently abandoning the tab can leave an orphaned journal after its session pointer disappears.
