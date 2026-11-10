---
title: Accessible editorial work
description: "Use the CMS with keyboard, zoom, reduced motion, and narrow screens while creating accessible public content."
---

## Accessibility is part of the editorial task

The CMS includes focus management, readable labels, adaptable density, reduced
motion support, and narrow-screen layouts. Those features help staff use the
workspace. Editors are also responsible for the accessibility of the content
they create.

An accessible workflow has two parts:

1. Use the CMS in a way that works with your input, display, and assistive
   technology.
2. Create public content whose structure, links, images, and documents remain
   understandable to visitors.

## Use the keyboard

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Keep the subject inside Crop preview.</strong> Click, tap, or drag the image. The arrow controls and keyboard provide the same adjustment without dragging. </figcaption>
</figure>

Start at the top of the page and use the skip link to move directly to the main
workspace.

Common browser behavior applies:

- <kbd>Tab</kbd> moves forward.
- <kbd>Shift</kbd> + <kbd>Tab</kbd> moves backward.
- <kbd>Enter</kbd> follows links and activates many controls.
- <kbd>Space</kbd> activates focused buttons and toggles where appropriate.
- Arrow keys move within menus, radio groups, and other composite controls that
  announce that pattern.
- <kbd>Escape</kbd> closes supported menus, popovers, and dialogs.

Some field explanations are behind an information icon. Select the icon, or
move keyboard focus to it, to open the explanation. Press <kbd>Escape</kbd> to
close it. Opening field help does not change the field value.

After navigation, the CMS should move focus to the new workspace heading and
announce the destination. If focus disappears, lands behind an overlay, or
returns to the top of the browser unexpectedly, record the route and the action
that caused it.

## Keep the focus indicator visible

The visible focus ring identifies the control that will receive the next
keyboard action. Do not suppress it with custom browser CSS.

When reviewing a new interface:

1. Tab through every interactive control.
2. Confirm that focus is always visible.
3. Confirm that the visual order matches the reading and action order.
4. Open and close menus or dialogs.
5. Confirm that focus returns to a sensible control.
6. Check that disabled controls are not the only way to discover why an action
   is unavailable.

## Use zoom and text scaling

The CMS should remain usable with browser zoom and operating-system text
scaling.

Test consequential work at the zoom level you normally use. At high zoom:

- The navigation can move into its narrow-screen pattern.
- Tables or long code-like values can scroll within their own region.
- Primary actions should remain reachable.
- Labels should not be clipped.
- Content should not require page-level horizontal scrolling.

Do not reduce zoom merely to reach a clipped action. Report the layout defect.

## Reduce motion and visual load

The site honors operating-system reduced-motion preferences, and the workspace
can offer density and control-presentation choices.

Use:

- **Compact**, **Comfortable**, or **Loose** density according to the amount of
  separation you need.
- Text-label controls when icons slow recognition. Phones always show icons.
- Your operating system's reduced-motion setting when animation is distracting
  or uncomfortable.

These preferences affect presentation, not authorization or saved content.

## Work on a narrow screen

At approximately phone width:

1. Open the menu and choose the intended workspace.
2. Confirm that the title and primary action are visible.
3. Use the content outline to move through long compositions.
4. Collapse sections you are not using.
5. Check that dialogs fit the viewport and can be closed.
6. Keep the save confirmation in view before leaving.
7. Reopen the record after a consequential save when persistence must be proven.

A phone-sized layout is useful for review and limited corrections. Use a wider
workspace for complex block rearrangement when the smaller screen makes order
or context difficult to verify.

## Preserve heading structure

Headings communicate document structure. Choose a heading block for structure,
not for its size.

- Use one clear page title supplied by the page template.
- Use second-level headings for major sections.
- Nest third- and fourth-level headings without skipping levels.
- Do not turn a paragraph into a heading for emphasis.
- Do not repeat the same heading when more specific labels would help
  navigation.

After moving a heading block, reread the outline to confirm that the hierarchy
still makes sense.

## Write descriptive links

A reader should understand a link without relying on the surrounding sentence.

Prefer:

- “Read the annual report”
- “View the NJ PBS schedule”
- “Download the public meeting notice (PDF)”

Avoid repeated “click here,” exposed raw URLs, or several links with the same
label but different destinations.

Before saving:

1. Read the link text alone.
2. Check the destination.
3. Confirm whether it leaves NJ PBS.
4. Identify a document's file type when useful.
5. Remove tracking or private query information that does not belong in the
   public URL.

## Use images responsibly

For every informative image:

- Select an authorized asset.
- Write contextual alternative text.
- Preserve the required credit.
- Check responsive cropping.
- Avoid embedding essential text in the image.
- Add a caption when the image needs editorial context beyond the alternative
  text.

For decorative imagery, use the CMS's decorative option when available. Do not
write meaningless alternative text just to remove a warning.

## Make tables and lists understandable

Use a list for a sequence or set of related items. Use a table only for data
that needs row-and-column relationships.

For tables:

- Provide clear column headers.
- Keep each cell concise.
- Avoid merged cells when possible.
- Do not use a table only to force visual alignment.
- Check the narrow-screen reading experience.
- Provide the same essential conclusion in surrounding text when the table is
  complex.

## Handle audio, video, and documents

When content links or embeds media:

- Provide captions for prerecorded video as required.
- Provide a transcript or equivalent for audio-only material.
- Check that controls have accessible names.
- Do not autoplay sound.
- Identify downloadable documents and ensure the source file is accessible.
- Provide contact or correction information when an accommodation process
  requires it.

Some players and feeds are locked integrations. Report an accessibility problem
with the integration name, public page, browser, and exact behavior rather than
trying to recreate the player as an editable block.

## Run a final accessibility review

Before submitting or publishing:

- Read headings in outline order.
- Tab through links and controls in the preview when available.
- Check link purpose.
- Check every informative image's alternative text and credit.
- Check that color is not the only status cue.
- Check desktop and narrow widths.
- Check zoom.
- Check documents and media alternatives.
- Correct any internal note or placeholder before review.

Accessibility review is part of completion, not a later polish pass.
