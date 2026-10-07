# Sheet dialog

`Sheet` is the shared bottom sheet. It listens for Escape in the capture
phase and dims the page with a backdrop button. It does not trap focus,
move initial focus into the sheet, restore focus on close, or expose
`role="dialog"` / `aria-modal`. While it is open, Tab still walks the page
underneath. The Ask panel in `ChatPanel` is a separate modal overlay with
the same hole.

This change puts one headless dialog primitive behind both overlays.
Library dialogs stay on the reducer in `src/lib/libraryFlow.ts`. Chat,
dictation, streaming, apply, and photo behavior stay as they are.

Constitutions: `docs/constitutions/client-state.md` Principle 6
(reducer-driven dialogs; the primitive must not own open state) and
Principle 7 (no DOM testing library). `docs/constitutions/i18n.md` does
not apply: no catalog string is added or changed. No constitution is
amended.

## Decisions

1. **Primitive.** `@radix-ui/react-dialog` at exactly `1.1.23`. One
   package, headless, peer range includes React 19 (`^19.0`), which
   covers the installed `react@^19.3.0`. `Dialog.Root` is controlled.
   `Dialog.Content` renders `role="dialog"`, traps focus (`FocusScope`
   `trapped` and `loop`), and exposes `onOpenAutoFocus` /
   `onCloseAutoFocus`. `DismissableLayer` listens for Escape in the
   capture phase on the top layer and dismisses only when that event is
   not `defaultPrevented`. `onPointerDownOutside` can cancel outside
   dismiss. Version `1.1.23` is the latest stable on the registry
   (1.2.0 is still a release candidate). Do not add
   `@radix-ui/themes`, shadcn, MUI, `react-aria`, or
   `react-aria-components`. Transitive packages that npm installs with
   the dialog package stay. Do not add them to `package.json` by hand.

   `react-aria-components` also supports React 19 and is unstyled. It
   is the larger suite for one dialog. Radix is the smaller dependency
   and its dismiss hooks match `dismissible` without a styled overlay.

   That exact version does **not** emit `aria-modal`. Set
   `aria-modal={true}` on `Dialog.Content`. Its default
   `onCloseAutoFocus` calls `preventDefault` and focuses `triggerRef`,
   which is empty when there is no `Dialog.Trigger`, and that
   `preventDefault` also skips `FocusScope`'s restore of
   `document.activeElement`. The shell restores the opener itself
   (decision 2). Do not add `Dialog.Trigger`.

2. **Controlled, and mounted only while open.** Parents keep today's
   conditional render (`{open && <Sheet …>}`, `{chatOpen && <ChatPanel …>}`).
   They keep owning open and close: Library through `libraryFlowReducer`,
   cook-log delete through `confirmingDelete`, share and save through
   their existing callbacks, Ask through `chatOpen`. Inside the shell,
   `Dialog.Root` is `open` (always true for the lifetime of the mount)
   and `modal`. `onOpenChange(false)` calls the parent's `onClose` only
   when `dismissible` is true. The primitive never holds Library's
   sheet state and never wraps the buttons that open a sheet.

   **What captures the opener.** `DialogShell` installs two document
   capture listeners (`pointerdown` and `click`) for the life of the
   module. They record `event.target.closest('button, a, input, textarea, select')`
   when that node is an `HTMLElement`. They do not `preventDefault` or
   stop propagation. On mount, a `useLayoutEffect` copies that element
   into a ref when it is outside the shell. If
   `document.activeElement` is an `HTMLElement` outside the shell and
   is not `body` or `documentElement`, that element wins instead. This
   runs before `FocusScope`'s effect moves focus, and the click capture
   runs before React's `onClick`, so the opener is known even when
   StrictMode remounts the shell after focus has already moved inside.
   Keyboard activation of a `<button>` fires `click`, so it is recorded
   too.

   **What restores it.** `onCloseAutoFocus` calls `preventDefault` (so
   Radix does not focus the empty trigger and does not also focus
   whatever `FocusScope` saved). If the panel is still connected,
   return without focusing. `StrictMode` replays the mount effect, and
   `FocusScope` runs this handler from a `setTimeout(0)` in that
   replay's cleanup while the sheet is still open. Focusing the opener
   then leaves Tab on the page underneath an autofocus sheet, because
   the trap's last-focused element was never recorded for the replay.
   A real close has already detached the panel, or cleared the ref, so
   the check does not skip it. Then `focus()` the captured element when
   it `isConnected`. `FocusScope` runs that handler from a timeout on
   unmount, after the parent has removed the shell and after
   `hideOthers` has cleared `aria-hidden`. Parents do not stay mounted
   with `open={false}`.

   **Opener already gone.** Move and Delete in the library overflow
   menu call `setMenuId(null)` in the same click that opens the sheet,
   so the menu item is disconnected before the shell mounts. Restore
   focuses nothing; focus stays on `body`. Do not keep the menu mounted
   and do not retarget the ⋯ button. Verification uses openers that
   stay mounted.

3. **`dismissible={false}` does not close.** Default stays `true`.
   Escape, the backdrop button, and outside-interact dismiss are all
   blocked while it is false. Focus stays trapped.

   Escape is handled only in `Dialog.Content`'s `onEscapeKeyDown`,
   which runs inside Radix's capture-phase listener:

   - always `preventDefault` and `stopImmediatePropagation`;
   - call `onClose` only when `dismissible` is true.

   `preventDefault` stops Radix from also calling `onDismiss` (that
   would close twice) and stops the browser from handling Escape.
   `stopImmediatePropagation` stops the event before bubble.
   `Library`'s bubble listener
   (`src/screens/Library.tsx`, the effect on `[menuId, sheet.kind]`)
   would otherwise `closeSheets()` for every open sheet except share,
   including a pending invite whose own `onClose` refuses to close.
   That listener is why capture-phase swallowing has to stay. Do not
   edit it. The comment there stays true.

   Pointer dismiss stays on the backdrop button (`onClick={onClose}`,
   `disabled={!dismissible}`), which is today's path. Always
   `preventDefault` in `onPointerDownOutside` and `onInteractOutside`
   so the primitive does not dismiss as well. A disabled backdrop does
   not fire `click`, so a busy sheet stays open. Do not call `onClose`
   from those outside handlers.

   When `dismissible` is true, Escape and the backdrop still call the
   existing `onClose`. Chat is always dismissible, including while a
   reply is streaming. Closing still unmounts the panel, and the
   existing unmount cleanup still aborts the request.

4. **Sheet layout is unchanged.** The shell renders this structure for
   `Sheet`. Classes are exact:

   - overlay: `fixed inset-0 z-30 flex flex-col justify-end`
   - backdrop: `type="button"`, `className="flex-1 bg-black/40"`,
     `aria-label={t('sheet.dismiss')}`, `tabIndex={-1}`,
     `disabled={!dismissible}`
   - panel: `max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:mx-auto md:w-full md:max-w-xl`

   One extra style on the overlay only: `style={{ pointerEvents: 'auto' }}`.
   Modal content sets `document.body.style.pointerEvents = 'none'`, and
   a descendant receives hits only when it sets `pointer-events` back
   to `auto`. Without that style the backdrop cannot be clicked. It is
   not a restyle. Do not add `Dialog.Overlay` and do not take
   `RemoveScroll`. The page is not body-scroll-locked today; do not
   add that.

5. **Name and role.** `role="dialog"` comes from `Dialog.Content`.
   Pass `aria-modal={true}` on that same node (the panel, not the
   overlay). Do not render `Dialog.Title` or `Dialog.Description`, and
   do not add a description string. Radix only sets `aria-labelledby`
   when a `Dialog.Title` is mounted; `content` props are spread after
   that, so the shell's `aria-labelledby` wins.

   In a layout effect, find the first `h1`, `h2`, or `h3` **inside the
   panel**. Every current sheet and the Ask panel have an `h2` there
   (library sheets, share, save, cook-log delete, `chat.assistant`).
   If it has no `id`, set one from `useId()`. Point `aria-labelledby`
   at that id. Do not add `aria-label`. Do not add a catalog string.
   A sheet with no heading gets no accessible name. None exist today;
   do not invent `sheet.dialog` or similar for that case.

6. **Initial focus, trap, restore.** `onOpenAutoFocus` calls
   `preventDefault` so Radix does not run its default (first tabbable,
   skipping `<a>`, which would focus Cancel on the add sheet and the
   email field on a coarse pointer). Then:

   - if the panel contains an enabled `[autofocus]` or `[data-autofocus]`
     element, `focus()` that element and do not `select()` its text
     (`data-autofocus` marks a non-control, such as the new-member intro's
     step heading, so a sheet that opens on its own shows no focus ring);
   - otherwise `focus({ preventScroll: true })` the panel.

   The panel is `tabIndex={-1}` via `FocusScope` `asChild`. Focusing it
   does not raise the mobile keyboard. That keeps
   `ShareCollectionSheet`'s `autoFocus={finePointer}` behavior: the
   email field is focused only for a fine pointer, because a phone
   keyboard covers the people list. Create, rename, and the empty
   save-to-collection input keep their existing `autoFocus`.

   Tab from the panel moves to the next tabbable inside it (the panel's
   descendants follow it in tree order). `FocusScope` loops Tab and
   Shift+Tab among those controls and pulls focus back on `focusin`
   outside the panel. The backdrop stays `tabIndex={-1}` and outside
   the content, so it is not in the cycle. The page underneath is not
   in the cycle. `hideOthers` marks the rest of the document
   `aria-hidden` while the dialog is mounted. It does not set `inert`.

   That pull-back misses one case. React `autoFocus` can focus a field
   before `FocusScope` attaches its `focusin` listener, so
   `lastFocusedElementRef` is still null. A later click on Share,
   cook-log Delete, or save-to-collection records that button, then
   `disabled` moves focus to `document.body` (`relatedTarget` is null,
   so the trap's `focusout` handler returns). The following `focusin`
   calls `focus` on the disabled button, or on null, and no-ops. The
   next Tab lands on the `data-radix-focus-guard` outside the panel
   and the Tab after that enters `#root`. `DialogFrame` adds its own
   bubble `focusin` listener in a `useEffect`, which runs after
   `FocusScope`'s effect and is therefore registered second. If the
   panel is connected and `document.activeElement` is outside it, the
   listener focuses the panel with `preventScroll`. Its cleanup removes
   the listener before `onCloseAutoFocus`'s `setTimeout(0)`, so a real
   close still focuses the opener.

   On close, decision 2 restores the captured opener when it is still
   connected. Add (the FAB), Rename, Share, Delete collection, Leave,
   cook-log delete, save-to-collection, and Ask qualify. Move and
   Delete from the recipe ⋯ menu do not.

7. **Chat uses the same shell.** Ask stays a dialog: backdrop, Escape,
   and a panel over the recipe. `ChatPanel` drops its own `keydown`
   effect (the one whose listener calls `onClose` on Escape) and drops
   the hand-rolled overlay markup. It renders `DialogShell` with:

   - overlay `fixed inset-0 z-20 flex flex-col justify-end`
   - backdrop label `t('chat.closeChat')` (existing), same button
     classes as today (`flex-1 bg-black/40`, `tabIndex={-1}`)
   - panel `flex h-[75dvh] flex-col rounded-t-3xl bg-surface shadow-2xl md:mx-auto md:w-full md:max-w-xl`

   Header, message list, composer, dictation, attach, send, streaming,
   and apply stay in `ChatPanel` as children of the panel. Do not put
   Ask through `Sheet` or Sheet's `max-h-[90dvh]` classes. Do not set
   `dismissible={false}` while `busy`. Initial focus is the panel, not
   the textarea and not Clear. The accessible name is the existing
   `h2` (`chat.assistant`).

   `RecipeView` currently unmounts the Ask button while chat is open
   (`{!chatOpen && (…button…)}`). The button is the opener, so it must
   stay mounted: otherwise the open commit disconnects it before the
   shell's layout effect, and restore no-ops. Add Tailwind `invisible`
   to that button only while `chatOpen` is true. Remove it in the close
   render. `invisible` does not reserve space (`fixed`) and is gone
   before `FocusScope`'s unmount `setTimeout(0)` calls `focus()`. Do
   not use `inert`. Do not unmount the button. The `z-20` overlay does
   not hide it: the panel is `md:max-w-xl` and centered, the backdrop
   is only the `flex-1` band above the panel, and the button is
   `fixed right-5 bottom-8`, so on wide viewports it paints through the
   transparent gutter. The overlay still takes those hits, so this
   class is for visibility only. `hideOthers` already sets
   `aria-hidden` on `#root`.

8. **Portal to `document.body`.** Use `Dialog.Portal` with its default
   container. One portal child: the overlay `div`. The backdrop and
   `Dialog.Content` sit inside that div, not as extra portal children.
   `body` has no transform, and `#root` is not an ancestor of the
   portaled node, so `fixed` is still the viewport. `z-30` (sheet) and
   `z-20` (chat) compete in the root stacking context with the in-app
   `z-30` toasts. The portaled sheet is appended after `#root`, so it
   paints above `SyncToast` and `LibraryInviteToast`, which is the same
   outcome as today (the sheet is later in the tree than those pills).
   Chat at `z-20` stays under those `z-30` pills. The library overflow
   menu is `z-20` inside the page; a `z-30` sheet still covers it.
   Radix focus guards are `span`s inserted at the start and end of
   `body` (`data-radix-focus-guard`). Leave them. They are not inside
   the flex column.

9. **No DOM testing library and no trap unit test.** Do not add
   Testing Library, jsdom tests, or a fake DOM to prove the trap.
   `scripts/invariants.test.ts` only locks `package.json` `"name"` to
   `"cook"`; do not edit that test. Do not extract a pure helper for
   this. Browser checks are the verification section below, not a step
   that claims they already passed.

10. **Plans table.** One new row in the plans table in `AGENTS.md`.
    Do not rewrite other sections of that file.

## Steps

### 1. [core] Install the dialog package

In `package.json` dependencies, add exactly:

```json
"@radix-ui/react-dialog": "1.1.23"
```

No caret. Run `npm install` so `package-lock.json` updates. Do not add
another UI package. The only file that imports
`@radix-ui/react-dialog` is `src/components/DialogShell.tsx` (step 2).

### 2. [core] Add `src/components/DialogShell.tsx`

New file. Default export. Props:

- `onClose: () => void`
- `dismissible?: boolean` (default `true`)
- `backdropLabel: string`
- `overlayClassName: string`
- `panelClassName: string`
- `children: ReactNode`

Behavior is decisions 2–6 and 8. Sketch the tree:

```tsx
<Dialog.Root
  open
  modal
  onOpenChange={(next) => {
    if (!next && dismissible) onClose();
  }}
>
  <Dialog.Portal>
    <div className={overlayClassName} style={{ pointerEvents: 'auto' }}>
      <button
        type="button"
        className="flex-1 bg-black/40"
        aria-label={backdropLabel}
        tabIndex={-1}
        disabled={!dismissible}
        onClick={onClose}
      />
      <Dialog.Content
        className={panelClassName}
        aria-modal={true}
        aria-labelledby={labelId}
        onOpenAutoFocus={focusOnOpen}
        onCloseAutoFocus={restoreOpener}
        onEscapeKeyDown={onEscape}
        onPointerDownOutside={swallowOutside}
        onInteractOutside={swallowOutside}
      >
        {children}
      </Dialog.Content>
    </div>
  </Dialog.Portal>
</Dialog.Root>
```

`labelId` is omitted until the layout effect has an id (pass
`undefined`, not a dangling id). `swallowOutside` always
`preventDefault`. `onEscape` is decision 3. `focusOnOpen` and
`restoreOpener` are decisions 6 and 2.

The module-level opener listeners are created once when this module
loads in the browser. Guard `document` so the file can be imported
under Vitest's node environment if some other test ever imports it.
Do not import this file from a test.

`Sheet` and `ChatPanel` are the only callers. No i18n import here;
callers pass `backdropLabel`.

### 3. [ui] Point `src/components/Sheet.tsx` at the shell

Keep the default export and the props `{ onClose, children, dismissible = true }`.
Replace the Escape effect and the hand-rolled tree with `DialogShell`:

- `backdropLabel={t('sheet.dismiss')}`
- `overlayClassName` and `panelClassName` from decision 4
- `dismissible` forwarded

Call sites stay conditional and keep their props. Do not edit
`src/screens/Library.tsx`, `src/screens/CookLogEdit.tsx`,
`src/components/ShareCollectionSheet.tsx`,
`src/components/SaveToCollectionSheet.tsx`, or
`src/lib/libraryFlow.ts`. `dismissible={!busy}` / `dismissible={!deleteBusy}`
/ `dismissible={!invitePending}` already express the busy lock.

### 4. [ui] Point the Ask overlay at the shell

In `src/components/ChatPanel.tsx`:

- Delete the Escape `useEffect` (the listener around the `onKeyDown`
  that calls `onClose`).
- Replace the outer `fixed inset-0 z-20` tree and its backdrop button
  with `DialogShell` as in decision 7.
- The current panel's children (header through composer) become
  `children`. Do not change send, stream, dictation, attach, clear,
  apply, or the unmount abort.

`onClose` on the header Close button stays.

### 5. [ui] Keep the Ask button mounted

In `src/screens/RecipeView.tsx`, render the Ask button whether or not
`chatOpen` is true. Same `type`, `onClick={() => setChatOpen(true)}`,
label `t('recipe.ask')`, and the same classes, plus `invisible` while
`chatOpen` is true. `{chatOpen && <ChatPanel …>}` stays. Do not change
`ChatPanel`'s props.

### 6. [core] Index the plan

Append one row to the plans table in `AGENTS.md`, after the
`library-agent` row:

```markdown
| `docs/plans/sheet-dialog.md` | In progress (this PR, #92). Headless dialog for Sheet and Ask: focus trap, initial focus, restore on close, dialog semantics. |
```

Do not edit any other `AGENTS.md` section. Do not edit a constitution.
Do not edit `src/i18n/` or `docs/i18n-review/screens.json`.

## Verification

Browser, not a unit test. Vite and `dev:api`, signed in, at
`http://localhost:5173` (`localhost`, not `127.0.0.1`). No Testing
Library. Do not run `npm run test:import`.

Library:

- Open Add from the FAB. Focus is inside the sheet (the panel, or the
  import link after one Tab). Tab and Shift+Tab cycle Import, Write
  from scratch, and Cancel, and never reach the search field, a card,
  or the FAB. Escape closes. The backdrop closes. Focus returns to the
  FAB.
- Open Rename on a named collection you own. The name input is focused
  on open (`autoFocus`). Escape and the backdrop close. Focus returns
  to the Rename control.
- Open Move or Delete from a recipe ⋯ menu. The menu item is gone, so
  focus need not return to it. Tab still must not reach the page.
  Closing can leave focus on `body`. That is not a failure.

Busy sheet (network throttled so the request stays in flight):

- Share, while an add is saving, or cook-log delete after confirming,
  or save-to-collection while a save is in flight. `dismissible` is
  false. Escape does not close. The backdrop does not close. Tab stays
  inside. Restore the network and let it finish.

Ask, on a recipe:

- Open Ask. Focus is inside the panel, not the page. Tab cycles header
  and composer controls and does not reach the recipe. Escape closes,
  including while a reply is streaming, and the in-flight request still
  aborts on unmount. The backdrop (`Close chat`) closes. Focus returns
  to the Ask button. Send, attach, and dictation still work. Do not
  restyle the panel.
- On a viewport wider than the panel (`md` and up), the Ask button is
  not visible while chat is open, including beside the centered panel.
  After Escape or the backdrop, focus returns to that button and it is
  visible again.

Also run `npm test` and `npm run build`. The new dependency and the
new TSX have to typecheck and must not break the existing node tests.
`package.json` `"name"` stays `"cook"`.

## Out of scope

- Library reducer, `deletingId` / `leavingId`, and moving
  `SaveToCollectionSheet` onto a reducer (client-state known exception).
- Chat streaming, dictation, apply, photos, and message rendering.
- New catalog strings, `screens.json`, and the in-context translation
  review.
- Body scroll lock, exit animation, and `Dialog.Trigger` at each opener.
- A DOM testing library or a unit test whose job is the focus trap.
