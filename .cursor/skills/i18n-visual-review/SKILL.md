---
name: i18n-visual-review
description: "Pre-PR in-context translation review for Sous. Run npm run test:i18n as docs/i18n-review/README.md describes. Not part of the iteration loop."
---

# In-context translation review (Cursor)

Follow `docs/i18n-review/README.md`: it says how to run `npm run test:i18n`
and what the report holds. Do not restate the rubric or the manifest.

This skill is not part of the iteration loop. Run it once, when the task's
implementation is complete and the PR may be ready to merge, before opening
the PR. Do not run it after each change.

Cursor specifics:

- Pass `--out /opt/cursor/artifacts/i18n-review/<date>` (`YYYY-MM-DD`) so
  the report and screenshots are uploaded. Do not use `.i18n-review/` for
  that Cursor report.
- The run needs Java for the Firestore emulator, a Chromium from
  `npx playwright install chromium`, and `GEMINI_API_KEY`. If the
  environment cannot provide them, review by hand in test mode as the
  README's "Without the suite" says, capturing screenshots through the
  `computerUse` subagent and judging them through a subagent given the
  images as file attachments.
